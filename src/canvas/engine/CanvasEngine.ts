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

import type { C4Object, Connection, Group, Flow, Tag, SelectedItem, ConnectionHighlightStyle, ConnectionShape, Position, Comment, ShapeIconAssignment } from '../../types'
import { resolveTechnologyIconPath } from '../../lib/technologies/iconPath'
import { objectShortDescription } from '../../lib/objectDescription'
import { objectTypeBadgeLabel } from '../../lib/objectTypeBadge'
import { safeExternalHref } from '../../lib/objectLinks'
import { useUIStore } from '../../stores/uiStore'
import i18n from '../../lib/i18n'
import type { SkinConfig } from '../../skins/types'
import { defaultSkin } from '../../skins/defaultSkin'
import { setCyberpunkAnimationsEnabled } from './cyberpunkAnimations'
import { buildRoundRectPath, strokeSelectionGlow, storeCapRy, buildCylinderPath, strokeStoreLid, lightenHex, clipGroupAccentToBox, clipObjectAccentToBox } from './objectBox'
import { resolveConnectionAnimation, hexToRgba, drawStrands, isDarkColor } from '../../skins/connectionAnimation'
import { resolveGroupBottomBarColors, resolveObjectBottomBarColors, resolveStatusColor, resolveTagColor, resolveTeamColor, resolveTechnologyColor } from '../bottomBarColors'
import { markClientTimeline, startClientTimelineMeasure } from '../../lib/observability/clientTimeline'
import {
  resolveConnectionPerspectiveTag,
  resolveHiddenTagState,
  resolvePinnedTagPresentation,
} from '../tagPerspective'
import {
  facetValues,
  objectFacetValues,
  resolveConnectionPerspectiveFacet,
  resolveFacetFocusMembership,
  resolveHiddenFacetState,
  resolvePinnedFacetPresentation,
  type ManagedPerspective,
} from '../facetPerspective'
import { ThemeBridge } from '../../plugins/sdk/bridge'
import { createRng } from '../../plugins/sdk/rng'
import type { AnimBag, Draw, RenderContext, BackgroundArgs, ObjectArgs, GroupArgs, ThemePlugin } from '../../plugins/sdk/contract'
import {
  DESCRIPTION_TO_TYPE_BADGE_GAP,
  TYPE_BADGE_HEIGHT,
  objectContentLayout,
} from '../objectContentLayout'
import {
  calculateSmartGuides,
  unionGuideRects,
  type GuideRect,
  type SmartGuide,
} from '../../lib/layout/alignmentGuides'
import { getOfficialTheme } from '../../plugins/official/registry'
import { getCommunityTheme } from '../../plugins/community/registry'
import type { FrameSnapshot, SnapshotObject } from '../../plugins/sandbox/snapshot'
import { SpatialGridIndex, type SpatialBounds } from './spatialGrid'
import { AdaptiveFrameQuality } from './frameQuality'

interface Viewport {
  x: number
  y: number
  scale: number
}

/** One shape a Copy style / Copy size click resolved to. */
export interface CopyTarget {
  id: string
  type: 'object' | 'group'
}

/** Which run of text on a shape or group an inline edit is aimed at. */
export type ObjectTextBand = 'title' | 'description'

/**
 * A rect that no point can fall inside — what a renderer records for a run it
 * did not paint, so a hit test resolves to nothing rather than to last frame.
 */
const EMPTY_TEXT_RECT: ObjectTextRect = {
  x: 0, y: 0, width: 0, height: 0, fontSize: 0, lineHeight: 0,
}

/**
 * What the inline editor is currently sitting on, so the canvas can suppress
 * exactly that run and nothing else.
 *
 * `kind` is load-bearing rather than decorative: object ids and group ids come
 * from the same `generateId()` pool and a parent wrapper deliberately mirrors
 * its object's name, so an id-only match would let a shape edit blank a group's
 * title (or the reverse) whenever the two ids collided.
 */
export interface InlineEditTarget {
  kind: 'object' | 'group'
  id: string
  band: ObjectTextBand
}

export interface ObjectTextRect {
  x: number
  y: number
  width: number
  height: number
  /** Font size actually DRAWN, after fitting and the theme's minimum. */
  fontSize: number
  lineHeight: number
}

/**
 * Where a shape's title and description were last painted, in WORLD units.
 *
 * Recorded by `renderObject` rather than recomputed on demand, and that is the
 * whole point. The fitted layout depends on a chain nothing outside the render
 * can cheaply reproduce — a vertical centring offset derived from a base-size
 * text wrap, a font-size fit loop that steps down in half-points, a per-theme
 * minimum, a store-specific line cap, and an ellipsis pass — and there are
 * ALREADY three divergent copies of that arithmetic in the tree (`renderObject`,
 * `fitObjectDescription` for the 3D board, and `lib/export/svg.ts`, which has
 * drifted far enough to hardcode the centring offset to zero).
 *
 * A fourth copy for hit-testing would be a fourth thing to drift. Recording what
 * was drawn makes the editor's box and the painted text agree by construction:
 * there is no second implementation that could disagree.
 *
 * Consequence to keep in mind: an entry exists only for a shape drawn in the
 * last frame with its text run. That is exactly the set a user can double-click,
 * except under the low-zoom LOD, which paints no text at all — there the first
 * click selects the shape, which restores the full renderer before the second.
 */
export interface ObjectTextBounds {
  title: ObjectTextRect
  /** Null when the shape has no description text painted. */
  description: ObjectTextRect | null
}

interface EngineCallbacks {
  onObjectSelect: (id: string | null, multi: boolean) => void
  onObjectMove?: (id: string, x: number, y: number) => void
  onObjectResize?: (id: string, x: number, y: number, width: number, height: number) => void
  onPlacementsCommit?: (updates: {
    objects: Array<{ id: string; position: Position; size?: { width: number; height: number } }>
    groups: Array<{ id: string; position?: Position; size?: { width: number; height: number }; autoSize?: boolean }>
  }) => void
  /** band is null when the double-click missed both text runs. */
  onObjectDoubleClick: (id: string, band: ObjectTextBand | null, screenX: number, screenY: number) => void
  /**
   * A double-click that landed on a group's painted title or description.
   *
   * Unlike the object callback this never fires with a null band: a group's box
   * is mostly empty space that belongs to its members, so a double-click in it
   * is not an edit unless it hit text.
   */
  onGroupDoubleClick: (id: string, band: ObjectTextBand, screenX: number, screenY: number) => void
  onConnectionSelect: (id: string | null) => void
  onConnectionDoubleClick: (id: string, screenX: number, screenY: number) => void
  onConnectionLabelMove: (connId: string, position: number, offset: number) => void
  onConnectionWaypointsChange: (connId: string, waypoints: Position[]) => void
  onConnectionStart: (fromId: string, fromType: 'object' | 'group', fromAnchor?: number) => void
  onConnectionEnd: (toId: string, toType: 'object' | 'group', toAnchor?: number) => void
  onConnectionAnchorMove: (connId: string, end: 'source' | 'target', targetId: string, anchorIndex: number) => void
  onZoom: (zoom: number) => void
  onCommentClick: (commentId: string, screenX: number, screenY: number) => void
  onCommentMove: (commentId: string, x: number, y: number) => void
  onContextMenu: (screenX: number, screenY: number, objectId: string | null, groupId: string | null, connectionId: string | null, selectedItems: SelectedItem[]) => void
  onGroupSelect: (id: string | null) => void
  onGroupMove?: (id: string, x: number, y: number) => void
  onGroupResize?: (id: string, x: number, y: number, width: number, height: number) => void
  /**
   * Apply a copied style/size to every target the click resolved to — one
   * shape normally, the whole selection when the click landed inside a
   * multi-selection.
   *
   * Return `false` to REFUSE, meaning NOTHING was written; the engine then
   * stays armed so the cursor keeps showing the pending paste rather than
   * disarming on a write that never happened. A partial application (some
   * targets refused, e.g. a parent wrapper caught in the selection) counts as
   * applied — one unstyleable shape must not veto the other nine. Anything
   * other than `false`, including `undefined`, counts as applied.
   */
  onCopyApply: (targets: readonly CopyTarget[], mode: 'size' | 'style', data: unknown) => boolean | void
  onExpandClick: (objectId: string, menuX: number, menuY: number) => void
  onGroupExpandClick?: (objectId: string, menuX: number, menuY: number) => void
  onGroupNavigateUp?: () => void
}

export interface CanvasViewportInsets {
  left?: number
  right?: number
  top?: number
  bottom?: number
}

/** One cubic-Bézier segment of a (possibly multi-segment) connection path. */
interface CubicSeg {
  x0: number
  y0: number
  cp1x: number
  cp1y: number
  cp2x: number
  cp2y: number
  x1: number
  y1: number
}

interface ConnectionGeometry {
  from: { cx: number; cy: number; width: number; height: number; face?: 'top' | 'bottom' | 'left' | 'right' } | null
  to: { cx: number; cy: number; width: number; height: number; face?: 'top' | 'bottom' | 'left' | 'right' } | null
  fromEdge: { x: number; y: number; face: 'top' | 'bottom' | 'left' | 'right' }
  toEdge: { x: number; y: number; face: 'top' | 'bottom' | 'left' | 'right' }
  /** Full path as ordered cubic segments (one entry when there are no waypoints). */
  segments: CubicSeg[]
  // Legacy first/last-segment control points (kept for back-compat with code that
  // still reads a single Bézier). For waypointed paths, drawing/sampling uses `segments`.
  cp1x: number
  cp1y: number
  cp2x: number
  cp2y: number
  fromLineX: number
  fromLineY: number
  toLineX: number
  toLineY: number
  bounds: { x: number; y: number; width: number; height: number }
  isHidden: boolean
  flowState: 'hidden' | 'dim' | 'active' | 'normal'
  isHovered: boolean
  isHighlighted: boolean
  isFocused: boolean
  alpha: number
}

// --- Parent-wrapper (expanded group) centered header ---------------------------
// The boundary box reserves a top band for a centered identity stack
// (icon → title → type → description) plus a slim bottom padding. The band height
// is computed per group (groupHeaderBandHeight) so it always fits exactly the
// present elements — members can never overlap it — without wasting space on
// sparse headers. The stack is top-aligned at HDR_TOP_INSET, which sits below the
// top-corner hit zones (back/expand icons occupy y ≤ 22) so centered text can't
// stray into them and trigger a mis-click.
const GROUP_FOOTER_PAD = 28
const MIN_HEADER_BAND = 46   // floor (parity with the legacy top reservation)
// Top reservation for a STANDARD (non-parent-wrapper) group: room for the top-left icon +
// title row (rowCenterY = y+22, icon bottom ≈ y+32) plus a comfortable gap to the first
// member. MIRRORS GROUP_STD_PAD_TOP in src/lib/layout/metrics.ts (custom + ELK + preview) —
// keep in lockstep. Sides/bottom keep the symmetric 30px pad.
const GROUP_STD_HEADER_PAD = 52
const HDR_TOP_INSET = 24     // stack top; clears the y ≤ 22 corner hit band
const HDR_BOTTOM_INSET = 12  // gap between the stack and the first member
const HDR_PAD_X = 16         // horizontal inset for centered text (each side)
const HDR_ICON = 20          // icon block height (renderTechnologyIcon draws 20px)
const HDR_GAP_ICON = 8       // gap below the icon
const HDR_GAP_TYPE = 4       // gap above the type line
const HDR_GAP_DESC = 6       // gap above the description line
const HDR_TITLE_BASE = 14
const HDR_TITLE_MIN = 10
const HDR_TYPE = 10
const HDR_DESC_BASE = 12
const HDR_DESC_MIN = 9.5
const HDR_MAX_TEXT_W = 360    // cap on text-driven box growth; longer text shrinks/truncates

const OBJECT_DESC_LINE_HEIGHT_FACTOR = 1.15

/** Memoized, fitted text layout of an object card (see getObjectTextLayout). */
interface ObjectTextLayout {
  contentTop: number
  titleSize: number
  titleText: string
  descSize: number
  descLines: string[]
}

/** Memoized, fitted layout of a parent-wrapper's centered header. Built once per
 *  (content + box width + font identity) so renderGroup never re-measures per frame. */
interface GroupHeaderLayout {
  titleText: string
  titleSize: number
  titleLineH: number
  typeText: string
  typeLineH: number
  descText: string
  descSize: number
  descLineH: number
  hasIcon: boolean
  stackHeight: number
}

export class CanvasEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr: number
  private viewport: Viewport = { x: 0, y: 0, scale: 1 }
  private objects: C4Object[] = []
  private connections: Connection[] = []
  private groups: Group[] = []
  private tags: Tag[] = []
  private comments: Comment[] = []
  private commentMap = new Map<string, Comment>()
  private commentIndex = new Map<string, number>()
  private openCommentId: string | null = null
  private flows: Flow[] = []
  // diagrams not needed in engine currently
  private selectedItems: SelectedItem[] = []
  private selectedObjectIds = new Set<string>()
  private selectedConnectionIds = new Set<string>()
  private selectedGroupIds = new Set<string>()
  private hoveredId: string | null = null
  private hoveredLinkId: string | null = null
  private hoveredExpandId: string | null = null
  private hoveredGroupExpandId: string | null = null
  private hoveredGroupNavigateId: string | null = null
  private draggingId: string | null = null
  private dragOffset = { x: 0, y: 0 }
  private dragMoved = false
  /** `dragMoved` carried past onMouseUp, which clears it before dblclick fires. */
  private lastGestureMoved = false
  private linkIndicatorClickedId: string | null = null
  private draggingCommentId: string | null = null
  private dragCommentOffset = { x: 0, y: 0 }
  private dragCommentMoved = false
  private draggingGroupId: string | null = null
  private dragGroupStartPositions = new Map<string, { x: number; y: number }>()
  private dragGroupStartPosition = { x: 0, y: 0 }
  private dragGroupStartBounds: GuideRect | null = null
  private dragMultiStartPositions = new Map<string, { x: number; y: number }>()
  private smartGuideCandidates: GuideRect[] = []
  private smartGuides: SmartGuide[] = []
  private smartGuideSnap = { x: false, y: false }
  private placementGestureStartedAt = 0
  private placementPreviewUpdates = 0

  // Resize handle state
  private resizingId: string | null = null
  private resizingType: 'object' | 'group' | null = null
  private resizeHandle: 'nw' | 'ne' | 'sw' | 'se' | null = null
  private resizeStartMouse = { x: 0, y: 0 }
  private resizeStartStates = new Map<string, { x: number; y: number; w: number; h: number }>()
  private resizeStartBounds = { x: 0, y: 0, w: 0, h: 0 }
  private hoveredResizeHandle: { handle: 'nw' | 'ne' | 'sw' | 'se'; targetId: string; targetType: 'object' | 'group' } | null = null

  // Copy mode state
  private copyMode: 'size' | 'style' | null = null
  private copyData: unknown = null
  private copyCursorPos = { x: 0, y: 0 }

  private isPanning = false
  private panStart = { x: 0, y: 0 }
  private viewportStart = { x: 0, y: 0 }
  private isBackgroundPanning = false
  private backgroundPanMoved = false
  private showGrid = true
  private snapToGrid = true
  private gridSize = 20

  // Interaction & fast render mode
  private isInteracting = false
  private interactionTimeoutId = 0
  private wheelTimeoutId = 0

  // Grid world-space rendering — no offscreen cache needed since dots are cheap and
  // must stay anchored to world coordinates to avoid the scintillating screen-space effect.

  private callbacks: EngineCallbacks
  private rafId = 0
  // Canvas-drawn chrome text (copy tooltip, back label, link "View" hover) is read live via
  // i18n.t() on every render, but nothing else triggers a redraw when the language changes —
  // this listener does, and is torn down in destroy().
  private onLanguageChanged = () => this.scheduleRender()
  // Text is measured against whatever face is available at the time. A web font
  // (Inter, Press Start 2P…) that arrives later changes every width under the
  // same cache key, so the measured layouts are dropped and the frame redrawn —
  // which also repaints immediately instead of on the next unrelated input.
  private onFontsLoaded = () => {
    this.objectTextLayoutCache.clear()
    this.groupHeaderCache.clear()
    // Group boxes widen to fit their measured title, and connection endpoints
    // follow group boxes, so both derived caches go with it.
    this.groupBoundsCache.clear()
    this.groupSpatialIndex = null
    this.connectionGeometryCache.clear()
    this.shapeConnectionSidesCache.clear()
    this.connectionSpatialIndex = null
    this.scheduleRender()
  }
  private needsRender = true
  private dataRevision = 0
  private renderedDataRevision = 0

  /** Request a render on the next frame. Restarts the RAF loop if it has gone idle. */
  private scheduleRender() {
    this.needsRender = true
    if (this.rafId === 0) {
      this.rafId = requestAnimationFrame(() => this.renderLoop())
    }
  }

  private toolMode: 'select' | 'connection' | 'pan' = 'select'
  private connectionFrom: string | null = null
  private connectionPreview = { x: 0, y: 0 }

  private hoveredConnectionId: string | null = null
  private bottomTab: 'tags' | 'technology' | 'status' | 'teams' | null = null
  private currentFlowId: string | null = null
  private currentFlowStepIndex: number = 0
  private flowEditMode = true
  private connectionAnimationTime = 0
  private connectionHighlightStyle: ConnectionHighlightStyle = 'traveling-dot'
  private connectionAnimationsEnabled = true

  private readonly = false
  /** Whether this diagram has a resolvable parent to navigate up to, which is
   *  what gates the wrapper group's top-left back glyph. Was
   *  `previousDiagramId` — in-memory session history that is null after any
   *  reload, so the glyph was simply not drawn for anyone who arrived by URL or
   *  from the diagrams list. The view resolves the target from
   *  `diagram.parentObjectId` (see resolveParentNavigation) and sets this. */
  private canNavigateUp = false

  // Tag interaction state
  private hoveredTagId: string | null = null
  private pinnedTagIds: string[] = []
  private activeTagGroupId: string | null = null
  private focusedTagId: string | null = null
  private hiddenTagIds: string[] = []
  private managedPerspectiveInteractions: Record<ManagedPerspective, {
    hoveredId: string | null
    pinnedIds: string[]
    focusedId: string | null
    hiddenIds: string[]
  }> = {
    technology: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: [] },
    status: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: [] },
    teams: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: [] },
  }

  // Connection endpoint drag state
  private draggingConnEndpoint: 'source' | 'target' | null = null
  private draggingConnId: string | null = null
  private connDragPreview = { x: 0, y: 0 }
  private hoveredAnchorShapeId: string | null = null

  // Connection waypoint (bend point) drag state
  private draggingWaypointConnId: string | null = null
  private draggingWaypointIndex: number | null = null
  // Working copy of the waypoints during a drag (committed to the store on mouseup)
  private workingWaypoints: Position[] | null = null
  // Pending waypoint insertion: set on mousedown over a selected connection's line,
  // materialized into a real waypoint only once the cursor moves (so a plain click
  // doesn't add one).
  private pendingWaypoint: { connId: string; index: number; startX: number; startY: number } | null = null

  // Connection label drag state
  private isDraggingLabel = false
  private draggingLabelConnId: string | null = null
  private dragLabelStartT = 0.5
  private dragLabelCurrentT = 0.5
  private dragLabelStartOffset = 0
  private dragLabelCurrentOffset = 0
  private hoveredLabelConnId: string | null = null

  // Shape anchor hover / creation state
  private hoveredGroupId: string | null = null
  private hoveredAnchorIndex: number | null = null
  private connectionFromAnchor: number | null = null
  private isAnchorDragging = false

  // Icon image cache
  private iconImageCache = new Map<string, HTMLImageElement>()
  private iconImageLoading = new Set<string>()
  private resolvedTheme: 'light' | 'dark' = 'light'
  private skin: SkinConfig = defaultSkin

  /** Drives theme plugins (animation lifecycle + per-seam draw hooks). */
  private themeBridge: ThemeBridge
  /** Animation values sampled once per frame from the active theme. */
  private frameAnim: AnimBag = {}
  /** RenderContext rebuilt once per frame and handed to theme seam hooks. */
  private frameRenderContext: RenderContext | null = null
  /** Overlay canvas a community theme's sandbox worker draws into (if active). */
  private overlayCanvas: HTMLCanvasElement | null = null
  /** UI-supplied handler for user-facing theme notices (unsupported / failure). */
  private themeNoticeHandler: ((message: string) => void) | null = null

  setThemeNoticeHandler(fn: ((message: string) => void) | null) {
    this.themeNoticeHandler = fn
  }

  // --- Performance caches ---
  private objectMap = new Map<string, C4Object>()
  private groupMap = new Map<string, Group>()
  private objectIndex = new Map<string, number>()
  private groupIndex = new Map<string, number>()
  private connectionIndex = new Map<string, number>()
  private groupIdsByObjectId = new Map<string, string[]>()
  /** Canonical IDs of currently hidden Tags. */
  private hiddenTagIdsSet = new Set<string>()
  private connectionMap = new Map<string, Connection>()
  /** Farthest a connection label box can reach from its path's bounds (setData). */
  private labelReach = { x: 0, y: 0 }
  /** Objects with at least one detail, reference, or parent diagram. */
  private relatedDiagramObjectIds = new Set<string>()
  // Object/group id -> connections touching it (registered under both endpoints).
  // Replaces per-object O(connections) adjacency scans. Rebuilt in setData().
  private adjacencyMap = new Map<string, Connection[]>()
  // Tag snapshot lookup, rebuilt in setData().
  private tagById = new Map<string, Tag>()
  private connectionGeometryCache = new Map<string, ConnectionGeometry>()
  private shapeConnectionSidesCache = new Map<string, Set<'top' | 'right' | 'bottom' | 'left'>>()
  // Eagerly-built tag-focus membership sets (no per-object lazy O(connections)
  // scan). tagFocusResolved is true only when a focused tag id resolves to a real
  // tag; when false (no focus, or id not found) every object is "focus", matching
  // the original. Rebuilt in setData() and setTagInteractions().
  private tagFocusSet = new Set<string>()
  private tagConnectedSet = new Set<string>()
  private tagFocusResolved = false
  // Cached group bounds, keyed by group id. Stores null results too (use .has()
  // to distinguish "uncached" from "cached null"). Invalidated in setData() and
  // at the in-place group-resize freeze (the only sites that change group/member
  // geometry without a setData round-trip).
  private groupBoundsCache = new Map<string, { x: number; y: number; width: number; height: number } | null>()
  // Fitted+truncated parent-wrapper header layouts, keyed by content+width+font
  // identity. Cleared wherever groupBoundsCache is (setData, resize-freeze) and on
  // setSkin (a skin change alters glyph widths → fitted sizes). Keeps the per-frame
  // renderGroup path a single Map lookup instead of an uncached measure loop.
  private groupHeaderCache = new Map<string, GroupHeaderLayout>()
  // Fitted object-card text, one entry per object id, each carrying the key it
  // was computed for (text + box size + font identity). Entries for objects that
  // left the diagram are pruned in setData; everything is dropped on setSkin and
  // when a web font finishes loading (measured widths change under the same key).
  private objectTextLayoutCache = new Map<string, { key: string; layout: ObjectTextLayout }>()
  // Object/group bounds are indexed independently from connection geometry so
  // pan/zoom work is proportional to the visible scene, not the whole diagram.
  // Transient placement updates replace only the touched entries.
  private objectSpatialIndex: SpatialGridIndex<number> | null = null
  private groupSpatialIndex: SpatialGridIndex<number> | null = null
  // Uniform spatial grid over connection geometry bounds. Buckets store indices
  // into this.connections so render and hit-test preserve canonical z-order.
  // Placement/waypoint gestures replace only affected entries; perspective and
  // flow filters rebuild lazily because they may change broad membership.
  private connectionSpatialIndex: SpatialGridIndex<number> | null = null
  private static readonly CONN_GRID_CELL = 256
  private static readonly SHAPE_GRID_CELL = 512
  private static readonly LOW_ZOOM_LOD = 0.35
  private readonly frameQuality = new AdaptiveFrameQuality()
  // Layered animation of the selection highlight (see render / renderLoop):
  // `deferredEffects` collects the effects while a layered frame draws; they are
  // kept in `animEffects` and redrawn each animation frame between the two
  // frozen layers — under (background … connection lines) and over (arrowheads,
  // shapes, overlays, comments).
  private deferredEffects: Array<{ geom: ConnectionGeometry; alpha: number }> | null = null
  private animEffects: Array<{ geom: ConnectionGeometry; alpha: number }> = []
  private animUnderLayer: HTMLCanvasElement | null = null
  private animOverLayer: HTMLCanvasElement | null = null
  private animLayersValid = false
  private lastFrameStats = {
    objectsDrawn: 0,
    groupsDrawn: 0,
    connectionsDrawn: 0,
    lowZoomLod: false,
  }

  constructor(canvas: HTMLCanvasElement, callbacks: EngineCallbacks, skin?: SkinConfig) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.dpr = window.devicePixelRatio || 1
    this.callbacks = callbacks
    this.skin = skin ?? defaultSkin
    // The ThemeBridge object literal's getters/callbacks below need a stable reference to this
    // CanvasEngine; `this` inside them would resolve to the literal, not the instance.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this
    this.themeBridge = new ThemeBridge({
      requestRender: () => engine.scheduleRender(),
      rng: (seedKey: string) => createRng(seedKey),
      get selectionActive() {
        return engine.selectedItems.length > 0
      },
      acquireOverlayCanvas: () => engine.acquireOverlayCanvas(),
      releaseOverlayCanvas: () => engine.releaseOverlayCanvas(),
      revertToDefault: () => engine.setSkin(defaultSkin),
      notify: (message: string) => {
        if (engine.themeNoticeHandler) engine.themeNoticeHandler(message)
        else console.warn(`[theme] ${message}`)
      },
    })
    this.themeBridge.activate(getOfficialTheme(this.skin.id))
    this.setupEvents()
    this.startRenderLoop()
    i18n.on('languageChanged', this.onLanguageChanged)
    globalThis.document?.fonts?.addEventListener?.('loadingdone', this.onFontsLoaded)
  }

  setSkin(skin: SkinConfig) {
    this.skin = skin
    // A skin change can alter the font family / floor and therefore measured glyph
    // widths, which feed group box width (title/description fit) and the header's
    // fitted font sizes. Invalidate both geometry + header caches so they re-measure
    // against the new skin.
    this.groupBoundsCache.clear()
    this.groupHeaderCache.clear()
    this.objectTextLayoutCache.clear()
    this.groupSpatialIndex = null
    this.connectionGeometryCache.clear()
    this.connectionSpatialIndex = null
    // Community (untrusted) themes route to the sandbox worker; official themes
    // run on the main thread. The base skin still renders non-replaced seams.
    const community = getCommunityTheme(skin.id)
    this.themeBridge.activate(community ?? getOfficialTheme(skin.id))
    this.scheduleRender()
  }

  /** Keep catalog artwork aligned with the application theme. The image cache
   * is URL-keyed, so switching themes can reuse both variants without stale
   * light artwork leaking onto a dark canvas. */
  setResolvedTheme(theme: 'light' | 'dark') {
    if (theme === this.resolvedTheme) return
    this.resolvedTheme = theme
    this.scheduleRender()
  }

  /** Activate an untrusted community theme (routed to the sandbox worker). The
   *  base skin keeps rendering non-replaced seams underneath the overlay. */
  activateCommunityTheme(plugin: ThemePlugin) {
    this.themeBridge.activate(plugin)
    this.scheduleRender()
  }

  deactivateCommunityTheme() {
    this.themeBridge.activate(getOfficialTheme(this.skin.id))
    this.scheduleRender()
  }

  /** Create + mount a fresh overlay canvas over the main canvas. */
  acquireOverlayCanvas(): HTMLCanvasElement {
    this.releaseOverlayCanvas()
    const overlay = document.createElement('canvas')
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;'
    const parent = this.canvas.parentElement
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
      parent.appendChild(overlay)
    }
    this.overlayCanvas = overlay
    return overlay
  }

  releaseOverlayCanvas() {
    if (this.overlayCanvas) {
      this.overlayCanvas.remove()
      this.overlayCanvas = null
    }
  }

  /** Build the per-frame scene snapshot for the community sandbox worker. */
  private buildFrameSnapshot(width: number, height: number): FrameSnapshot {
    const objects: SnapshotObject[] = []
    for (const obj of this.objects) {
      if (this.isObjectHidden(obj)) continue
      const bounds = { x: obj.position.x, y: obj.position.y, width: obj.size.width, height: obj.size.height }
      if (!this.isInViewport(bounds, 100)) continue
      objects.push({
        id: obj.id,
        type: obj.type,
        name: obj.name,
        x: obj.position.x,
        y: obj.position.y,
        w: obj.size.width,
        h: obj.size.height,
        cornerRadius: this.skin.objects[obj.type].cornerRadius,
        selected: this.isObjectSelected(obj.id),
        hovered: this.hoveredId === obj.id,
        external: obj.scope === 'external',
        alpha: 1,
      })
    }
    const groups: FrameSnapshot['groups'] = []
    for (const group of this.groups) {
      const bounds = this.getGroupBounds(group)
      if (!bounds) continue
      if (!this.isInViewport(bounds, 100)) continue
      groups.push({
        id: group.id,
        isParentWrapper: !!group.parentObjectId,
        x: bounds.x,
        y: bounds.y,
        w: bounds.width,
        h: bounds.height,
        cornerRadius: 12,
        selected: this.isGroupSelected(group.id),
      })
    }

    const connections: FrameSnapshot['connections'] = []
    for (const conn of this.connections) {
      if (this.isConnectionHidden(conn)) continue
      const geom = this.getConnectionGeometry(conn)
      if (!geom) continue
      if (!this.isInViewport(geom.bounds, 100)) continue
      connections.push({
        id: conn.id,
        type: conn.type,
        fromX: geom.fromLineX,
        fromY: geom.fromLineY,
        cp1x: geom.cp1x,
        cp1y: geom.cp1y,
        cp2x: geom.cp2x,
        cp2y: geom.cp2y,
        toX: geom.toLineX,
        toY: geom.toLineY,
        fromEdgeX: geom.fromEdge.x,
        fromEdgeY: geom.fromEdge.y,
        toEdgeX: geom.toEdge.x,
        toEdgeY: geom.toEdge.y,
        hovered: geom.isHovered,
        highlighted: geom.isHighlighted,
        alpha: geom.alpha,
      })
    }

    return {
      viewport: { x: this.viewport.x, y: this.viewport.y, scale: this.viewport.scale },
      dpr: this.dpr,
      canvas: { width, height },
      timeMs: this.connectionAnimationTime,
      fastMode: this.isInteracting,
      bg: this.skin.canvas.bg,
      objects,
      groups,
      connections,
    }
  }

  /**
   * Apply transient geometry without involving React, Zustand or Automerge.
   * Pointer gestures call this for their preview and commit the final values
   * through `onPlacementsCommit` only once on mouse-up.
   */
  private invalidateConnectionGeometry(connectionId: string): void {
    this.connectionGeometryCache.delete(connectionId)
    if (!this.connectionSpatialIndex) return
    const index = this.connectionIndex.get(connectionId)
    const connection = this.connectionMap.get(connectionId)
    if (index === undefined || !connection) return
    this.connectionSpatialIndex.remove(index)
    const geometry = this.getConnectionGeometry(connection)
    if (geometry) this.connectionSpatialIndex.insert(geometry.bounds, index)
  }

  updatePlacements(updates: {
    objects?: Array<{ id: string; position: Position; size?: { width: number; height: number } }>
    groups?: Array<{ id: string; position?: Position; size?: { width: number; height: number }; autoSize?: boolean }>
  }): void {
    const objectUpdates = updates.objects ?? []
    const groupUpdates = updates.groups ?? []
    if (objectUpdates.length === 0 && groupUpdates.length === 0) return
    if (this.placementGestureStartedAt > 0) this.placementPreviewUpdates += 1

    const affectedShapeIds = new Set<string>()
    const affectedGroupIds = new Set<string>()
    if (objectUpdates.length > 0) this.objects = this.objects.slice()
    for (const update of objectUpdates) {
      const index = this.objectIndex.get(update.id)
      if (index === undefined) continue
      const current = this.objects[index]
      const next: C4Object = {
        ...current,
        position: { ...update.position },
        ...(update.size ? { size: { ...update.size } } : {}),
      }
      this.objects[index] = next
      this.objectMap.set(update.id, next)
      affectedShapeIds.add(update.id)
      for (const groupId of this.groupIdsByObjectId.get(update.id) ?? []) {
        affectedGroupIds.add(groupId)
        affectedShapeIds.add(groupId)
      }
    }

    if (groupUpdates.length > 0) this.groups = this.groups.slice()
    for (const update of groupUpdates) {
      const index = this.groupIndex.get(update.id)
      if (index === undefined) continue
      const current = this.groups[index]
      const next: Group = {
        ...current,
        ...(update.position ? { position: { ...update.position } } : {}),
        ...(update.size ? { size: { ...update.size } } : {}),
        ...(update.autoSize !== undefined ? { autoSize: update.autoSize } : {}),
      }
      this.groups[index] = next
      this.groupMap.set(update.id, next)
      affectedGroupIds.add(update.id)
      affectedShapeIds.add(update.id)
    }

    for (const groupId of affectedGroupIds) this.groupBoundsCache.delete(groupId)
    if (groupUpdates.some((update) => update.size !== undefined)) this.groupHeaderCache.clear()
    const affectedConnectionIds = new Set<string>()
    for (const shapeId of affectedShapeIds) {
      this.shapeConnectionSidesCache.delete(shapeId)
      for (const connection of this.adjacencyMap.get(shapeId) ?? []) {
        this.connectionGeometryCache.delete(connection.id)
        affectedConnectionIds.add(connection.id)
        this.shapeConnectionSidesCache.delete(connection.fromId)
        this.shapeConnectionSidesCache.delete(connection.toId)
      }
    }
    if (this.objectSpatialIndex) {
      for (const update of objectUpdates) {
        const index = this.objectIndex.get(update.id)
        const object = this.objectMap.get(update.id)
        if (index === undefined || !object) continue
        this.objectSpatialIndex.insert({
          x: object.position.x,
          y: object.position.y,
          width: object.size.width,
          height: object.size.height,
        }, index)
      }
    }
    if (this.groupSpatialIndex) {
      for (const groupId of affectedGroupIds) {
        const index = this.groupIndex.get(groupId)
        const group = this.groupMap.get(groupId)
        if (index === undefined || !group) continue
        this.groupSpatialIndex.remove(index)
        const bounds = this.getGroupBounds(group)
        if (bounds) this.groupSpatialIndex.insert(bounds, index)
      }
    }
    if (this.connectionSpatialIndex) {
      for (const connectionId of affectedConnectionIds) {
        const index = this.connectionIndex.get(connectionId)
        const connection = this.connectionMap.get(connectionId)
        if (index === undefined || !connection) continue
        this.connectionSpatialIndex.remove(index)
        const geometry = this.getConnectionGeometry(connection)
        if (geometry) this.connectionSpatialIndex.insert(geometry.bounds, index)
      }
    }
    this.dataRevision += 1
    this.scheduleRender()
  }

  private commitPlacements(updates: {
    objects: Array<{ id: string; position: Position; size?: { width: number; height: number } }>
    groups: Array<{ id: string; position?: Position; size?: { width: number; height: number }; autoSize?: boolean }>
  }): void {
    if (updates.objects.length === 0 && updates.groups.length === 0) return
    markClientTimeline('canvas.gesture.commit', {
      durationMs: this.placementGestureStartedAt > 0
        ? performance.now() - this.placementGestureStartedAt
        : undefined,
      objects: updates.objects.length,
      groups: updates.groups.length,
      previewUpdates: this.placementPreviewUpdates,
      persistentCommits: 1,
    })
    this.placementGestureStartedAt = 0
    this.placementPreviewUpdates = 0
    if (this.callbacks.onPlacementsCommit) {
      this.callbacks.onPlacementsCommit(updates)
      return
    }
    for (const update of updates.objects) {
      if (update.size) {
        this.callbacks.onObjectResize?.(
          update.id,
          update.position.x,
          update.position.y,
          update.size.width,
          update.size.height,
        )
      } else {
        this.callbacks.onObjectMove?.(update.id, update.position.x, update.position.y)
      }
    }
    for (const update of updates.groups) {
      if (update.size && update.position) {
        this.callbacks.onGroupResize?.(
          update.id,
          update.position.x,
          update.position.y,
          update.size.width,
          update.size.height,
        )
      } else if (update.position) {
        this.callbacks.onGroupMove?.(update.id, update.position.x, update.position.y)
      }
    }
  }

  /**
   * React/read-model refreshes may call setData while a pointer gesture is in
   * progress. The engine owns the transient placement until mouse-up, so an
   * incoming snapshot must not replace the position/size currently under the
   * pointer. All non-placement fields still come from the fresh snapshot and
   * the normal store round-trip becomes authoritative after the commit.
   */
  private preserveActivePlacementPreview(
    objects: C4Object[],
    groups: Group[],
  ): { objects: C4Object[]; groups: Group[] } {
    const objectIds = new Set<string>()
    const groupIds = new Set<string>()

    if (this.draggingId) {
      if (this.dragMultiStartPositions.size > 0) {
        for (const id of this.dragMultiStartPositions.keys()) objectIds.add(id)
      } else {
        objectIds.add(this.draggingId)
      }
    }
    if (this.draggingGroupId) {
      groupIds.add(this.draggingGroupId)
      for (const id of this.dragGroupStartPositions.keys()) objectIds.add(id)
    }
    if (this.resizingId) {
      if (this.resizingType === 'object') {
        if (this.resizeStartStates.size > 0) {
          for (const id of this.resizeStartStates.keys()) objectIds.add(id)
        } else {
          objectIds.add(this.resizingId)
        }
      } else if (this.resizingType === 'group') {
        groupIds.add(this.resizingId)
      }
    }

    if (objectIds.size === 0 && groupIds.size === 0) return { objects, groups }

    const mergedObjects = objects.map((object) => {
      if (!objectIds.has(object.id)) return object
      const preview = this.objectMap.get(object.id)
      return preview
        ? { ...object, position: { ...preview.position }, size: { ...preview.size } }
        : object
    })
    const mergedGroups = groups.map((group) => {
      if (!groupIds.has(group.id)) return group
      const preview = this.groupMap.get(group.id)
      if (!preview) return group
      return {
        ...group,
        ...(preview.position ? { position: { ...preview.position } } : {}),
        ...(preview.size ? { size: { ...preview.size } } : {}),
        autoSize: preview.autoSize,
      }
    })
    return { objects: mergedObjects, groups: mergedGroups }
  }

  setData(
    objects: C4Object[],
    connections: Connection[],
    groups: Group[] = [],
    flows: Flow[] = [],
    tags: Tag[] = [],
    relatedDiagramObjectIds: ReadonlySet<string> = new Set(),
  ) {
    const finishSetData = startClientTimelineMeasure('canvas.setData')
    const preserved = this.preserveActivePlacementPreview(objects, groups)
    objects = preserved.objects
    groups = preserved.groups
    this.objects = objects
    this.connections = connections
    this.groups = groups
    this.flows = flows
    this.tags = tags
    this.relatedDiagramObjectIds = new Set(relatedDiagramObjectIds)
    this.objectMap = new Map(objects.map((o) => [o.id, o]))
    this.groupMap = new Map(groups.map((g) => [g.id, g]))
    // Painted-text rects belong to the frame that drew them. Anything not in the
    // new data will never be redrawn, so its rect would sit here for the rest of
    // the session — a slow leak, and a live hit target for a group that has left
    // the diagram. The rects for what IS still here are rewritten on the next
    // render, which `setData` schedules.
    for (const id of this.groupTextBounds.keys()) {
      if (!this.groupMap.has(id)) this.groupTextBounds.delete(id)
    }
    for (const id of this.objectTextBounds.keys()) {
      if (!this.objectMap.has(id)) this.objectTextBounds.delete(id)
    }
    for (const id of this.objectTextLayoutCache.keys()) {
      if (!this.objectMap.has(id)) this.objectTextLayoutCache.delete(id)
    }
    this.objectIndex = new Map(objects.map((object, index) => [object.id, index]))
    this.groupIndex = new Map(groups.map((group, index) => [group.id, index]))
    this.connectionIndex = new Map(connections.map((connection, index) => [connection.id, index]))
    this.groupIdsByObjectId = new Map<string, string[]>()
    for (const group of groups) {
      for (const objectId of group.objectIds) {
        const groupIds = this.groupIdsByObjectId.get(objectId)
        if (groupIds) groupIds.push(group.id)
        else this.groupIdsByObjectId.set(objectId, [group.id])
      }
    }
    this.connectionMap = new Map(connections.map((c) => [c.id, c]))
    // Same box arithmetic as getConnectionLabelBounds, maximised over every label.
    let labelHalfW = 0
    let labelHalfH = 0
    for (const c of connections) {
      if (!c.label) continue
      const lines = c.label.split('\n')
      labelHalfW = Math.max(labelHalfW, (Math.max(...lines.map((l) => l.length)) * 6 + 16) / 2)
      labelHalfH = Math.max(labelHalfH, (lines.length * 12 + 8) / 2)
    }
    this.labelReach = labelHalfW > 0 ? { x: labelHalfW + 41, y: labelHalfH + 41 } : { x: 0, y: 0 }
    this.adjacencyMap = new Map<string, Connection[]>()
    for (const c of connections) {
      const from = this.adjacencyMap.get(c.fromId)
      if (from) from.push(c)
      else this.adjacencyMap.set(c.fromId, [c])
      if (c.toId !== c.fromId) {
        const to = this.adjacencyMap.get(c.toId)
        if (to) to.push(c)
        else this.adjacencyMap.set(c.toId, [c])
      }
    }
    this.tagById = new Map<string, Tag>()
    for (const t of tags) {
      if (!this.tagById.has(t.tagId)) this.tagById.set(t.tagId, t)
    }
    this.refreshHiddenTagNames()
    this.connectionGeometryCache.clear()
    this.shapeConnectionSidesCache.clear()
    this.groupBoundsCache.clear()
    this.groupHeaderCache.clear()
    this.objectSpatialIndex = null
    this.groupSpatialIndex = null
    this.connectionSpatialIndex = null
    this.rebuildTagFocusSets()
    this.dataRevision += 1
    finishSetData({
      objects: objects.length,
      connections: connections.length,
      groups: groups.length,
    })
    this.scheduleRender()
  }

  setRelatedDiagramObjectIds(objectIds: ReadonlySet<string>) {
    if (
      objectIds.size === this.relatedDiagramObjectIds.size
      && [...objectIds].every((id) => this.relatedDiagramObjectIds.has(id))
    ) return
    this.relatedDiagramObjectIds = new Set(objectIds)
    this.scheduleRender()
  }

  setReadonly(value: boolean) {
    this.readonly = value
    this.scheduleRender()
  }

  setCanNavigateUp(value: boolean) {
    if (this.canNavigateUp === value) return
    this.canNavigateUp = value
    this.scheduleRender()
  }

  private startInteraction() {
    if (!this.isInteracting) {
      this.isInteracting = true
      this.scheduleRender()
    }
    if (this.interactionTimeoutId) {
      clearTimeout(this.interactionTimeoutId)
      this.interactionTimeoutId = 0
    }
  }

  private endInteraction() {
    this.interactionTimeoutId = window.setTimeout(() => {
      this.isInteracting = false
      this.scheduleRender()
      this.interactionTimeoutId = 0
    }, 150)
  }

  private getAnchorSide(anchorIndex: number): 'top' | 'right' | 'bottom' | 'left' {
    const def = this.anchorDefs[anchorIndex]
    return def?.side ?? 'top'
  }

  private getShapeConnectionSides(shapeOrGroupId: string): Set<'top' | 'right' | 'bottom' | 'left'> {
    const cached = this.shapeConnectionSidesCache.get(shapeOrGroupId)
    if (cached) return cached

    const sides = new Set<'top' | 'right' | 'bottom' | 'left'>()
    for (const conn of this.connections) {
      const isFrom = conn.fromId === shapeOrGroupId
      const isTo = conn.toId === shapeOrGroupId
      if (!isFrom && !isTo) continue

      if (conn.lockedToAnchors) {
        if (isFrom && conn.fromAnchor !== undefined) {
          sides.add(this.getAnchorSide(conn.fromAnchor))
        }
        if (isTo && conn.toAnchor !== undefined) {
          sides.add(this.getAnchorSide(conn.toAnchor))
        }
      } else {
        const geom = this.getConnectionGeometry(conn)
        if (!geom) continue
        if (isFrom) sides.add(geom.fromEdge.face)
        if (isTo) sides.add(geom.toEdge.face)
      }
    }
    this.shapeConnectionSidesCache.set(shapeOrGroupId, sides)
    return sides
  }

  private getActiveAnchorIndices(shapeOrGroupId: string): number[] {
    const connectedSides = this.getShapeConnectionSides(shapeOrGroupId)
    const indices: number[] = []
    for (const [side, centerIdx] of Object.entries(this.centerAnchorIndices)) {
      indices.push(centerIdx)
      if (connectedSides.has(side as 'top' | 'right' | 'bottom' | 'left')) {
        for (const idx of this.sideAnchorIndices[side as 'top' | 'right' | 'bottom' | 'left']) {
          if (!indices.includes(idx)) indices.push(idx)
        }
      }
    }
    return indices.sort((a, b) => a - b)
  }

  setSelectedItems(items: SelectedItem[]) {
    this.selectedItems = items
    this.selectedObjectIds = new Set(items.filter((item) => item.type === 'object').map((item) => item.id))
    this.selectedConnectionIds = new Set(items.filter((item) => item.type === 'connection').map((item) => item.id))
    this.selectedGroupIds = new Set(items.filter((item) => item.type === 'group').map((item) => item.id))
    this.scheduleRender()
  }

  // --- Selection helpers ---
  private isObjectSelected(id: string): boolean {
    return this.selectedObjectIds.has(id)
  }

  private isConnectionSelected(id: string): boolean {
    return this.selectedConnectionIds.has(id)
  }

  private isGroupSelected(id: string): boolean {
    return this.selectedGroupIds.has(id)
  }

  private getSelectedObjectIds(): string[] {
    return [...this.selectedObjectIds]
  }

  private hasObjectSelection(): boolean {
    return this.selectedObjectIds.size > 0
  }

  private hasSelection(): boolean {
    return this.selectedItems.length > 0
  }

  private getSingleSelectedConnectionId(): string | null {
    return this.selectedConnectionIds.size === 1 ? this.selectedConnectionIds.values().next().value ?? null : null
  }



  setShowGrid(show: boolean) {
    this.showGrid = show
    this.scheduleRender()
  }

  setBottomTab(tab: 'tags' | 'technology' | 'status' | 'teams' | null) {
    this.bottomTab = tab
    this.rebuildTagFocusSets()
    this.connectionSpatialIndex = null
    this.scheduleRender()
  }

  setActiveTagGroup(groupId: string | null) {
    if (this.activeTagGroupId === groupId) return
    this.activeTagGroupId = groupId
    this.scheduleRender()
  }

  setTagInteractions(hovered: string | null, pinned: string[], focused: string | null, hidden: string[]) {
    this.hoveredTagId = hovered
    this.pinnedTagIds = pinned
    this.focusedTagId = focused
    this.hiddenTagIds = hidden
    this.refreshHiddenTagNames()
    this.rebuildTagFocusSets()
    this.connectionSpatialIndex = null
    this.scheduleRender()
  }

  setManagedPerspectiveInteractions(
    kind: ManagedPerspective,
    hoveredId: string | null,
    pinnedIds: string[],
    focusedId: string | null,
    hiddenIds: string[],
  ) {
    this.managedPerspectiveInteractions[kind] = {
      hoveredId,
      pinnedIds: [...pinnedIds],
      focusedId,
      hiddenIds: [...hiddenIds],
    }
    if (this.bottomTab === kind) {
      this.rebuildTagFocusSets()
      this.connectionSpatialIndex = null
      this.scheduleRender()
    }
  }

  setFlowState(flowId: string | null, stepIndex: number) {
    this.currentFlowId = flowId
    this.currentFlowStepIndex = stepIndex
    this.connectionSpatialIndex = null
    this.scheduleRender()
  }

  setFlowEditMode(mode: boolean) {
    this.flowEditMode = mode
    this.connectionSpatialIndex = null
    this.scheduleRender()
  }

  setConnectionHighlightStyle(style: ConnectionHighlightStyle) {
    this.connectionHighlightStyle = style
    this.scheduleRender()
  }

  setConnectionAnimationsEnabled(enabled: boolean) {
    this.connectionAnimationsEnabled = enabled
    this.scheduleRender()
    setCyberpunkAnimationsEnabled(enabled)
  }

  setComments(comments: Comment[]) {
    this.comments = comments
    this.commentMap = new Map(comments.map((comment) => [comment.id, comment]))
    this.commentIndex = new Map(comments.map((comment, index) => [comment.id, index]))
    this.scheduleRender()
  }

  private updateCommentPlacement(id: string, position: Position): void {
    const index = this.commentIndex.get(id)
    if (index === undefined) return
    const current = this.comments[index]
    const next = { ...current, position: { ...position } }
    this.comments = this.comments.slice()
    this.comments[index] = next
    this.commentMap.set(id, next)
    this.scheduleRender()
  }

  setOpenCommentId(id: string | null) {
    this.openCommentId = id
    this.scheduleRender()
  }

  setToolMode(mode: 'select' | 'connection' | 'pan') {
    this.toolMode = mode
    this.canvas.style.cursor = mode === 'pan' ? 'grab' : 'default'
  }

  zoomToFit(insets: CanvasViewportInsets = {}) {
    if (this.objects.length === 0) {
      this.viewport = { x: 0, y: 0, scale: 1 }
      this.scheduleRender()
      return
    }
    const bounds = this.getBounds()
    const padding = 100
    const canvasWidth = this.canvas.width / this.dpr
    const canvasHeight = this.canvas.height / this.dpr
    const left = Math.max(0, insets.left ?? 0)
    const right = Math.max(0, insets.right ?? 0)
    const top = Math.max(0, insets.top ?? 0)
    const bottom = Math.max(0, insets.bottom ?? 0)
    const visibleWidth = Math.max(1, canvasWidth - left - right)
    const visibleHeight = Math.max(1, canvasHeight - top - bottom)
    const scaleX = visibleWidth / (bounds.width + padding * 2)
    const scaleY = visibleHeight / (bounds.height + padding * 2)
    this.viewport.scale = Math.min(scaleX, scaleY, 1.5)
    this.viewport.x = left + visibleWidth / 2 - (bounds.x + bounds.width / 2) * this.viewport.scale
    this.viewport.y = top + visibleHeight / 2 - (bounds.y + bounds.height / 2) * this.viewport.scale
    this.scheduleRender()
  }

  setZoom(zoom: number) {
    const centerX = this.canvas.width / this.dpr / 2
    const centerY = this.canvas.height / this.dpr / 2
    const worldX = (centerX - this.viewport.x) / this.viewport.scale
    const worldY = (centerY - this.viewport.y) / this.viewport.scale
    this.viewport.scale = Math.max(0.1, Math.min(4, zoom))
    this.viewport.x = centerX - worldX * this.viewport.scale
    this.viewport.y = centerY - worldY * this.viewport.scale
    this.scheduleRender()
  }

  getZoom() {
    return this.viewport.scale
  }

  /** Raw viewport handoff for the 2D↔3D morph (screen = world·scale + offset). */
  getViewport(): { x: number; y: number; scale: number } {
    return { x: this.viewport.x, y: this.viewport.y, scale: this.viewport.scale }
  }

  /** Set the viewport wholesale — the 3D board hands its final framing back
   * through this on exit, so the flat canvas resumes where the camera looked. */
  setViewport(v: { x: number; y: number; scale: number }) {
    this.viewport = { x: v.x, y: v.y, scale: Math.max(0.1, Math.min(4, v.scale)) }
    this.callbacks.onZoom(this.viewport.scale)
    this.scheduleRender()
  }

  focusOnBounds(bounds: { x: number; y: number; width: number; height: number }, padding = 120) {
    const canvasWidth = this.canvas.width / this.dpr
    const canvasHeight = this.canvas.height / this.dpr
    const scaleX = canvasWidth / (bounds.width + padding * 2)
    const scaleY = canvasHeight / (bounds.height + padding * 2)
    this.viewport.scale = Math.max(0.1, Math.min(scaleX, scaleY, 1.5))
    this.viewport.x = canvasWidth / 2 - (bounds.x + bounds.width / 2) * this.viewport.scale
    this.viewport.y = canvasHeight / 2 - (bounds.y + bounds.height / 2) * this.viewport.scale
    this.scheduleRender()
  }

  /** Centre on a shape or group. Returns false (viewport untouched) when the
   *  id is not drawn on this diagram. */
  focusOnObject(objectId: string, padding = 120): boolean {
    const obj = this.objects.find((o) => o.id === objectId)
    if (obj) {
      this.focusOnBounds(
        { x: obj.position.x, y: obj.position.y, width: obj.size.width, height: obj.size.height },
        padding
      )
      return true
    }
    const group = this.groups.find((g) => g.id === objectId)
    if (group) {
      const bounds = this.getGroupBounds(group)
      if (bounds) {
        this.focusOnBounds(bounds, padding)
        return true
      }
    }
    return false
  }

  /** Centre on a connection's two endpoints. Returns false (viewport untouched)
   *  when the connection or an endpoint is not drawn on this diagram. */
  focusOnConnection(connectionId: string, padding = 120): boolean {
    const conn = this.connections.find((c) => c.id === connectionId)
    if (!conn) return false
    const from = this.getConnectionEndpoint(conn.fromId, conn.lockedToAnchors ? conn.fromAnchor : undefined)
    const to = this.getConnectionEndpoint(conn.toId, conn.lockedToAnchors ? conn.toAnchor : undefined)
    if (!from || !to) return false

    // Compute bounds that encompass both endpoints
    const minX = Math.min(from.cx, to.cx) - Math.max(from.width, to.height) / 2
    const minY = Math.min(from.cy, to.cy) - Math.max(from.height, to.height) / 2
    const maxX = Math.max(from.cx, to.cx) + Math.max(from.width, to.height) / 2
    const maxY = Math.max(from.cy, to.cy) + Math.max(from.height, to.height) / 2
    this.focusOnBounds(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      padding
    )
    return true
  }

  focusOnFlowStep(flow: Flow, stepIndex: number) {
    if (stepIndex < 0 || stepIndex >= flow.steps.length) return
    const step = flow.steps[stepIndex]
    if (!step) return

    if (step.type === 'process') {
      this.focusOnObject(step.objectId)
    } else if (step.type === 'message') {
      if (step.connectionId) {
        this.focusOnConnection(step.connectionId)
      } else if (step.fromObjectId && step.toObjectId) {
        // Fallback: focus on the two objects
        const fromObj = this.objects.find((o) => o.id === step.fromObjectId)
        const toObj = this.objects.find((o) => o.id === step.toObjectId)
        if (fromObj && toObj) {
          const minX = Math.min(fromObj.position.x, toObj.position.x)
          const minY = Math.min(fromObj.position.y, toObj.position.y)
          const maxX = Math.max(fromObj.position.x + fromObj.size.width, toObj.position.x + toObj.size.width)
          const maxY = Math.max(fromObj.position.y + fromObj.size.height, toObj.position.y + toObj.size.height)
          this.focusOnBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY })
        } else if (fromObj) {
          this.focusOnObject(step.fromObjectId)
        } else if (toObj) {
          this.focusOnObject(step.toObjectId)
        }
      }
    } else if (step.type === 'introduction' || step.type === 'information' || step.type === 'conclusion') {
      // Show the whole diagram
      this.zoomToFit()
    }
  }

  setCopyMode(mode: 'size' | 'style' | null, data: unknown = null) {
    this.copyMode = mode
    this.copyData = data
    // Reset, or the tooltip shows the PREVIOUS arming's count until the mouse
    // first moves: arm over a 5-shape selection, paste, then arm again with
    // nothing selected and the label still promises "→ 5 shapes".
    this.copyTargetCount = 0
    this.scheduleRender()
    if (mode) {
      this.canvas.style.cursor = mode === 'size' ? 'copy' : 'alias'
    } else {
      this.canvas.style.cursor = this.toolMode === 'pan' ? 'grab' : 'default'
    }
  }

  getCopyMode() {
    return { mode: this.copyMode, data: this.copyData }
  }

  /**
   * The shapes a Copy style / Copy size click at (x, y) applies to.
   *
   * One shape normally. But when the click lands INSIDE a multi-selection, it
   * applies to the whole selection — that is the "apply to several shapes"
   * gesture, and it reuses the membership rule multi-drag already uses
   * (`selected.length > 1 && selected.includes(hit.id)`) so the two feel the
   * same. Clicking a shape OUTSIDE the selection applies to that shape alone,
   * exactly as before; a click is never silently redirected onto shapes the
   * user is not pointing at.
   *
   * Unlike the multi-selection context menu — which counts OBJECTS only,
   * because it is an object-shape menu — this counts selected groups too: the
   * user picked them, and both kinds can carry a style.
   *
   * Empty array means "nothing here", which the caller treats as a click on
   * empty space.
   *
   * Note for anyone mutation-testing this: `selected.length > 1` and
   * `> 0` are EQUIVALENT here, not a covered/uncovered pair. With exactly one
   * item selected and the click inside it, `selected` and `[hit]` are the same
   * array, so no test can tell them apart. `> 1` is kept because it states the
   * intent — "this is the multi-selection branch".
   */
  private copyTargetsAt(x: number, y: number): CopyTarget[] {
    // `skipHidden`: a shape hidden by a Tag/status perspective is not drawn, so
    // pasting onto it writes a change the user cannot see onto a shape they did
    // not know was there. Fall through to whatever IS visible underneath.
    const object = this.hitTest(x, y, { skipHidden: true })
    const hit: CopyTarget | null = object
      ? { id: object.id, type: 'object' }
      : (() => {
          const group = this.hitTestGroup(x, y)
          return group ? { id: group.id, type: 'group' as const } : null
        })()
    if (!hit) return []

    const insideSelection = hit.type === 'object'
      ? this.selectedObjectIds.has(hit.id)
      : this.selectedGroupIds.has(hit.id)
    if (!insideSelection) return [hit]

    // Expanding to the selection means writing to shapes the user is NOT
    // pointing at, so the set is filtered to what they can actually see and
    // what can actually take the paste. Otherwise the tooltip's count — which
    // is a promise now — over-states, and worse, hidden shapes get rewritten
    // invisibly in an app with no undo.
    const selected: CopyTarget[] = [
      ...this.getSelectedObjectIds()
        .filter((id) => {
          const object = this.objectMap.get(id)
          return object ? !this.isObjectHidden(object) : false
        })
        .map((id) => ({ id, type: 'object' as const })),
      ...[...this.selectedGroupIds]
        // A parent wrapper paints from the skin and derives its own geometry, so
        // it refuses both commands. Skipping it here (rather than letting the
        // apply refuse it) keeps the count honest. A DIRECT click on one still
        // reaches the apply and still refuses, which is what leaves the cursor
        // armed — the two cases mean different things.
        .filter((id) => !this.groupMap.get(id)?.parentObjectId)
        .map((id) => ({ id, type: 'group' as const })),
    ]
    if (selected.length > 1) return selected
    return [hit]
  }

  /**
   * How many shapes the pending paste would land on if the user clicked where
   * the cursor is. Drives the count on the copy tooltip — without it the label
   * promises "Copy style" and silently restyles nine other shapes.
   */
  private copyTargetCount = 0

  /** Where each shape's text was last painted. See `ObjectTextBounds`. */
  private objectTextBounds = new Map<string, ObjectTextBounds>()

  /** Where each group's text was last painted. Same contract, same reasons. */
  private groupTextBounds = new Map<string, ObjectTextBounds>()

  /** The run currently being edited inline, suppressed from the canvas. */
  private inlineEditTarget: InlineEditTarget | null = null

  /**
   * Suppress a text run so the inline editor is not drawn on top of the stale
   * value it is replacing. Without it the canvas keeps painting the old text —
   * fitted, truncated and possibly a different size — behind a textarea showing
   * the draft, and the two disagree around the edges.
   */
  setInlineEditTarget(target: InlineEditTarget | null): void {
    this.inlineEditTarget = target
    this.scheduleRender()
  }

  /** Whether `band` on this entity is the run currently being edited. */
  private isEditingRun(kind: 'object' | 'group', id: string, band: ObjectTextBand): boolean {
    const target = this.inlineEditTarget
    return target?.kind === kind && target.id === id && target.band === band
  }

  /** Where `id`'s text was last painted, or null if it has not been drawn. */
  getObjectTextBounds(id: string): ObjectTextBounds | null {
    return this.objectTextBounds.get(id) ?? null
  }

  /** Where group `id`'s text was last painted, or null if it has not been drawn. */
  getGroupTextBounds(id: string): ObjectTextBounds | null {
    return this.groupTextBounds.get(id) ?? null
  }

  /**
   * Which of a group's text runs a world-space point falls in, or null.
   *
   * Deliberately NOT widened the way `objectTextBandAt` widens a shape's bands.
   * A shape is almost entirely text, so a near miss there still means the text;
   * a group's box is mostly empty canvas holding its members, and widening the
   * title band across it would turn every double-click on a member's
   * surroundings into a rename. The bands here are the painted rectangles plus a
   * small vertical tolerance, and nothing more.
   */
  /**
   * The topmost group whose painted text a point falls in, or null.
   *
   * Deliberately NOT `hitTestGroup` plus one band lookup. `hitTestGroup` picks a
   * single winner by BOX — the last group in paint order whose rectangle
   * contains the point — which for the ordinary authoring move of wrapping an
   * existing group in a bigger one is the outer group. Asking only that one for
   * a band means the inner group's title, plainly painted on screen, resolves to
   * nothing and cannot be double-clicked at all.
   *
   * Text bands are exact and tiny, so overlap between two of them is not a
   * conflict worth arbitrating by box: walk paint order backwards and take the
   * first band that actually contains the point.
   */
  private groupTextHitAt(worldX: number, worldY: number): { id: string; band: ObjectTextBand } | null {
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const band = this.groupTextBandAt(this.groups[i].id, worldX, worldY)
      if (band) return { id: this.groups[i].id, band }
    }
    return null
  }

  groupTextBandAt(id: string, worldX: number, worldY: number): ObjectTextBand | null {
    const bounds = this.groupTextBounds.get(id)
    if (!bounds) return null
    const pad = 4
    // A zero-size rect is the record of a run that was NOT painted, so no point
    // may fall in it — without this the padding alone would make an 8x8 band.
    const hit = (rect: ObjectTextRect) =>
      rect.width > 0
      && rect.height > 0
      && worldX >= rect.x - pad
      && worldX <= rect.x + rect.width + pad
      && worldY >= rect.y - pad
      && worldY <= rect.y + rect.height + pad
    // Description first: on a parent wrapper the two rects are adjacent, and the
    // title's padded band would otherwise swallow the description's first pixels.
    if (bounds.description && hit(bounds.description)) return 'description'
    if (hit(bounds.title)) return 'title'
    return null
  }

  /**
   * Which text run a world-space point falls in, or null for neither.
   *
   * The bands are widened from the painted rects to the shape's content column
   * so there is no dead gap between them: a double-click between the title and
   * the description must mean something. The title band STOPS at the
   * description's top even when the painted title is taller — cyberpunk and
   * graffiti draw a 17px title into a slot that is a fixed 16px above the
   * description, so the painted rects genuinely overlap and the description
   * would otherwise be unreachable under those themes.
   */
  objectTextBandAt(id: string, worldX: number, worldY: number): ObjectTextBand | null {
    const bounds = this.objectTextBounds.get(id)
    const object = this.objectMap.get(id)
    if (!bounds || !object) return null
    const left = bounds.title.x
    const right = left + bounds.title.width
    if (worldX < left || worldX > right) return null

    const titleTop = bounds.title.y - 8
    const titleBottom = bounds.description
      ? bounds.description.y
      : bounds.title.y + bounds.title.height + 8
    if (worldY >= titleTop && worldY < titleBottom) return 'title'
    if (bounds.description) {
      const descBottom = bounds.description.y + bounds.description.height + 6
      if (worldY >= bounds.description.y && worldY < descBottom) return 'description'
    }
    return null
  }

  resize(width: number, height: number) {
    this.canvas.width = width * this.dpr
    this.canvas.height = height * this.dpr
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.ctx.scale(this.dpr, this.dpr)
    this.scheduleRender()
  }

  /** Override the raster density (offscreen export supersampling — 1×/2×/3×).
   * Call before resize(); on-screen canvases keep the device pixel ratio. */
  setPixelRatio(ratio: number) {
    this.dpr = ratio
  }

  /** World-space geometry of every visible connection, for the SVG exporter:
   * the exact cubic segments the canvas draws, the arrow tip with its approach
   * direction, and the de-colliding label anchor. Read-only. */
  getExportConnectionGeometries(): Array<{
    id: string
    segments: Array<{ x0: number; y0: number; cp1x: number; cp1y: number; cp2x: number; cp2y: number; x1: number; y1: number }>
    fromEdge: { x: number; y: number }
    toEdge: { x: number; y: number }
    preTip: { x: number; y: number }
    labelAt: { x: number; y: number } | null
  }> {
    const out: ReturnType<CanvasEngine['getExportConnectionGeometries']> = []
    for (const conn of this.connections) {
      if (this.isConnectionHidden(conn)) continue
      const geom = this.getConnectionGeometry(conn)
      if (!geom) continue
      let labelAt: { x: number; y: number } | null = null
      if (conn.label) {
        const t = conn.labelPosition ?? 0.5
        const offset = Math.max(-40, Math.min(40, conn.labelOffset ?? 12))
        const pt = this.getPathPoint(geom, t)
        const tangent = this.getPathTangent(geom, t)
        labelAt = { x: pt.x + -tangent.y * offset, y: pt.y + tangent.x * offset }
      }
      out.push({
        id: conn.id,
        segments: geom.segments,
        fromEdge: { x: geom.fromEdge.x, y: geom.fromEdge.y },
        toEdge: { x: geom.toEdge.x, y: geom.toEdge.y },
        preTip: this.getPathPoint(geom, 0.95),
        labelAt,
      })
    }
    return out
  }

  destroy() {
    i18n.off('languageChanged', this.onLanguageChanged)
    globalThis.document?.fonts?.removeEventListener?.('loadingdone', this.onFontsLoaded)
    this.animUnderLayer = null
    this.animOverLayer = null
    this.animEffects = []
    this.animLayersValid = false
    cancelAnimationFrame(this.rafId)
    if (this.interactionTimeoutId) clearTimeout(this.interactionTimeoutId)
    if (this.wheelTimeoutId) clearTimeout(this.wheelTimeoutId)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    this.canvas.removeEventListener('mousemove', this.onMouseMove)
    this.canvas.removeEventListener('mouseup', this.onMouseUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('dblclick', this.onDoubleClick)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
  }

  // --- Event Handlers ---

  private setupEvents() {
    this.canvas.addEventListener('mousedown', this.onMouseDown)
    this.canvas.addEventListener('mousemove', this.onMouseMove)
    this.canvas.addEventListener('mouseup', this.onMouseUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('dblclick', this.onDoubleClick)
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
  }

  private onMouseDown = (e: MouseEvent) => {
    const pos = this.screenToWorld(e.offsetX, e.offsetY)

    if (e.button === 2) {
      // Right-click is handled by contextmenu event
      return
    }

    // Handle copy mode click (blocked in readonly)
    if (this.copyMode && e.button === 0 && !this.readonly) {
      const targets = this.copyTargetsAt(pos.x, pos.y)
      if (targets.length > 0) {
        const applied = this.callbacks.onCopyApply(targets, this.copyMode, this.copyData) !== false
        // Hold Shift to CHAIN: the cursor stays armed so the same style or size
        // can be stamped onto shape after shape without re-opening the menu for
        // each one. Releasing Shift and clicking ends it, as does Escape or a
        // click on empty space — so there is always a way out that does not
        // require noticing the modifier.
        if (applied && !e.shiftKey) {
          this.setCopyMode(null)
        }
        return
      }
      // Clicked on empty space — cancel copy mode
      this.setCopyMode(null)
      return
    }

    if (e.button === 1 || (e.button === 0 && this.toolMode === 'pan')) {
      this.isPanning = true
      this.panStart = { x: e.clientX, y: e.clientY }
      this.viewportStart = { ...this.viewport }
      this.canvas.style.cursor = 'grabbing'
      this.startInteraction()
      return
    }

    // Check if clicking on a comment bubble (start potential drag)
    if (e.button === 0) {
      const comment = this.hitTestComment(e.offsetX, e.offsetY)
      if (comment) {
        this.draggingCommentId = comment.id
        const worldPos = this.screenToWorld(e.offsetX, e.offsetY)
        this.dragCommentOffset = { x: worldPos.x - comment.position.x, y: worldPos.y - comment.position.y }
        this.dragCommentMoved = false
        return
      }
    }

    // During flow play mode, disable all selection and editing interactions
    if (!this.flowEditMode && this.currentFlowId) {
      this.isBackgroundPanning = true
      this.backgroundPanMoved = false
      this.panStart = { x: e.clientX, y: e.clientY }
      this.viewportStart = { ...this.viewport }
      return
    }

    if (this.readonly) {
      // In readonly mode, skip all editing interactions
      // Selection is handled below
    } else if (this.toolMode === 'connection') {
      const obj = this.hitTest(pos.x, pos.y)
      if (obj) {
        if (!this.connectionFrom) {
          this.connectionFrom = obj.id
          this.connectionPreview = pos
          this.scheduleRender()
        } else if (this.connectionFrom !== obj.id) {
          this.callbacks.onConnectionEnd(obj.id, 'object')
          this.connectionFrom = null
          this.scheduleRender()
        }
        return
      }
      const group = this.hitTestGroup(pos.x, pos.y)
      if (group) {
        if (!this.connectionFrom) {
          this.connectionFrom = group.id
          this.connectionPreview = pos
          this.scheduleRender()
        } else if (this.connectionFrom !== group.id) {
          this.callbacks.onConnectionEnd(group.id, 'group')
          this.connectionFrom = null
          this.scheduleRender()
        }
        return
      }
      return
    }

    // Check if clicking on a resize handle (skip in readonly)
    const resizeHit = !this.readonly ? this.hitTestResizeHandle(pos.x, pos.y) : null
    if (resizeHit) {
      this.placementGestureStartedAt = performance.now()
      this.placementPreviewUpdates = 0
      this.resizingId = resizeHit.targetId
      this.resizingType = resizeHit.targetType
      this.resizeHandle = resizeHit.handle
      this.resizeStartMouse = { x: pos.x, y: pos.y }
      this.resizeStartStates.clear()

      const selectedObjectIds = this.getSelectedObjectIds()
      if (resizeHit.targetType === 'object' && selectedObjectIds.length > 1 && selectedObjectIds.includes(resizeHit.targetId)) {
        // Multi-resize: capture all selected objects
        for (const id of selectedObjectIds) {
          const obj = this.objects.find((o) => o.id === id)
          if (obj) {
            this.resizeStartStates.set(id, { x: obj.position.x, y: obj.position.y, w: obj.size.width, h: obj.size.height })
          }
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const id of selectedObjectIds) {
          const obj = this.objects.find((o) => o.id === id)
          if (obj) {
            minX = Math.min(minX, obj.position.x)
            minY = Math.min(minY, obj.position.y)
            maxX = Math.max(maxX, obj.position.x + obj.size.width)
            maxY = Math.max(maxY, obj.position.y + obj.size.height)
          }
        }
        this.resizeStartBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
      } else if (resizeHit.targetType === 'object') {
        const obj = this.objects.find((o) => o.id === resizeHit.targetId)
        if (obj) {
          this.resizeStartStates.set(resizeHit.targetId, { x: obj.position.x, y: obj.position.y, w: obj.size.width, h: obj.size.height })
          this.resizeStartBounds = { x: obj.position.x, y: obj.position.y, w: obj.size.width, h: obj.size.height }
        }
      } else if (resizeHit.targetType === 'group') {
        const group = this.groups.find((g) => g.id === resizeHit.targetId)
        if (group) {
          const bounds = this.getGroupBounds(group)
          if (bounds) {
            // If group has members and autoSize, freeze bounds into position/size and disable autoSize
            if (group.objectIds.length > 0 && group.autoSize !== false) {
              this.updatePlacements({
                groups: [{
                  id: group.id,
                  position: { x: bounds.x, y: bounds.y },
                  size: { width: bounds.width, height: bounds.height },
                  autoSize: false,
                }],
              })
            }
            this.resizeStartStates.set(resizeHit.targetId, { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height })
            this.resizeStartBounds = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
          }
        }
      }
      this.dragMoved = true
      return
    }

    // Check if clicking on a connection endpoint anchor dot to start re-routing
    // (prioritize over anchor creation when a connection is selected)
    const anchorHit = !this.readonly ? this.hitTestAnchorDot(pos.x, pos.y) : null
    if (anchorHit) {
      this.draggingConnEndpoint = anchorHit.end
      this.draggingConnId = anchorHit.connId
      this.connDragPreview = pos
      this.scheduleRender()
      return
    }

    // Connection waypoint (bend point) editing for the selected connection.
    if (!this.readonly) {
      const selectedConnId = this.getSingleSelectedConnectionId()
      if (selectedConnId) {
        // Grab an existing waypoint dot to move it.
        const wpHit = this.hitTestWaypointDot(pos.x, pos.y)
        if (wpHit) {
          const conn = this.connections.find((c) => c.id === wpHit.connId)
          this.draggingWaypointConnId = wpHit.connId
          this.draggingWaypointIndex = wpHit.index
          this.workingWaypoints = (conn?.waypoints ?? []).map((p) => ({ ...p }))
          this.scheduleRender()
          return
        }
        // Press on the selected connection's line → arm a pending bend point that is
        // only inserted once the cursor actually moves (so a plain click won't add one).
        const onLine = this.hitTestConnection(pos.x, pos.y)
        if (onLine && onLine.id === selectedConnId) {
          const geom = this.getConnectionGeometry(onLine)
          const index = geom ? this.findSegmentIndexAt(geom, pos.x, pos.y) : 0
          this.pendingWaypoint = { connId: selectedConnId, index, startX: pos.x, startY: pos.y }
          return
        }
      }
    }

    // Check if clicking on a shape anchor to start connection creation (skip in readonly)
    if (!this.readonly && this.hoveredAnchorIndex !== null && this.hoveredId) {
      this.connectionFrom = this.hoveredId
      this.connectionFromAnchor = this.hoveredAnchorIndex
      this.isAnchorDragging = true
      this.connDragPreview = pos
      this.callbacks.onConnectionStart(this.hoveredId, 'object', this.hoveredAnchorIndex)
      this.scheduleRender()
      return
    }
    if (!this.readonly && this.hoveredAnchorIndex !== null && this.hoveredGroupId) {
      this.connectionFrom = this.hoveredGroupId
      this.connectionFromAnchor = this.hoveredAnchorIndex
      this.isAnchorDragging = true
      this.connDragPreview = pos
      this.callbacks.onConnectionStart(this.hoveredGroupId, 'group', this.hoveredAnchorIndex)
      this.scheduleRender()
      return
    }

    // Check if clicking on a connection label. Labels render *below* shapes
    // (see render order: connections+labels are drawn before objects), so a shape
    // covering the label must win the hit test — only grab the label when no
    // object sits on top of the cursor.
    const labelConn = this.hitTestConnectionLabel(pos.x, pos.y)
    if (labelConn && !this.readonly && !this.hitTest(pos.x, pos.y)) {
      this.isDraggingLabel = true
      this.draggingLabelConnId = labelConn.id
      this.dragLabelStartT = labelConn.labelPosition ?? 0.5
      this.dragLabelCurrentT = this.dragLabelStartT
      this.dragLabelStartOffset = labelConn.labelOffset ?? 12
      this.dragLabelCurrentOffset = this.dragLabelStartOffset
      this.callbacks.onObjectSelect(null, false)
      this.callbacks.onGroupSelect(null)
      this.callbacks.onConnectionSelect(labelConn.id)
      this.scheduleRender()
      return
    }

    // Comment hover
    const hoveredComment = this.hitTestComment(e.offsetX, e.offsetY)
    if (hoveredComment) {
      if (this.canvas.style.cursor !== 'pointer') {
        this.canvas.style.cursor = 'pointer'
      }
      // Clear other hovers
      if (this.hoveredId || this.hoveredGroupId || this.hoveredConnectionId || this.hoveredAnchorIndex !== null || this.hoveredGroupExpandId || this.hoveredGroupNavigateId) {
        this.hoveredId = null
        this.hoveredGroupId = null
        this.hoveredConnectionId = null
        this.hoveredLinkId = null
        this.hoveredExpandId = null
        this.hoveredGroupExpandId = null
        this.hoveredGroupNavigateId = null
        this.hoveredAnchorIndex = null
        this.scheduleRender()
      }
      return
    }

    const obj = this.hitTest(pos.x, pos.y)
    if (obj) {
      // Check expand indicator click (top-right)
      if (obj.type !== 'actor' && this.isClickOnExpandIndicator(obj, pos.x, pos.y)) {
        const screenPos = this.worldToScreen(obj.position.x + obj.size.width, obj.position.y)
        this.callbacks.onExpandClick(obj.id, screenPos.x + 12, screenPos.y)
        this.scheduleRender()
        return
      }

      // Check link indicator click (top-left)
      if (obj.links && obj.links.length > 0 && this.isClickOnLinkIndicator(obj, pos.x, pos.y)) {
        this.linkIndicatorClickedId = obj.id
      }

      // In readonly mode, only allow selection, not drag
      if (this.readonly) {
        this.callbacks.onObjectSelect(obj.id, e.shiftKey)
        return
      }

      this.draggingId = obj.id
      this.placementGestureStartedAt = performance.now()
      this.placementPreviewUpdates = 0
      this.dragOffset = { x: pos.x - obj.position.x, y: pos.y - obj.position.y }
      // If dragging an object that's part of a multi-selection, capture all selected object positions
      this.dragMultiStartPositions.clear()
      const selectedObjectIds = this.getSelectedObjectIds()
      if (selectedObjectIds.length > 1 && selectedObjectIds.includes(obj.id)) {
        for (const id of selectedObjectIds) {
          const selectedObj = this.objects.find((o) => o.id === id)
          if (selectedObj) {
            this.dragMultiStartPositions.set(id, { ...selectedObj.position })
          }
        }
      }
      const draggedIds = this.dragMultiStartPositions.size > 0
        ? new Set(this.dragMultiStartPositions.keys())
        : new Set([obj.id])
      this.captureSmartGuideCandidates(draggedIds)
      this.callbacks.onObjectSelect(obj.id, e.shiftKey)
    } else {
      // Check if clicked on a connection
      const conn = this.hitTestConnection(pos.x, pos.y)
      if (conn) {
        this.callbacks.onObjectSelect(null, false)
        this.callbacks.onGroupSelect(null)
        this.callbacks.onConnectionSelect(conn.id)
      } else {
        // Check if clicked on a group
        const group = this.hitTestGroup(pos.x, pos.y)
        if (group) {
          const isParentWrapper = !!group.parentObjectId
          // Check group expand icon click (parent wrapper only)
          if (isParentWrapper && this.callbacks.onGroupExpandClick && this.isClickOnGroupExpandIndicator(group, pos.x, pos.y)) {
            const gx = (group.position?.x ?? 0) + (group.size?.width ?? 0)
            const gy = group.position?.y ?? 0
            const screenPos = this.worldToScreen(gx, gy)
            this.callbacks.onGroupExpandClick(group.parentObjectId!, screenPos.x + 12, screenPos.y)
            this.scheduleRender()
            return
          }
          // Check group navigate-up icon click (parent wrapper only)
          if (isParentWrapper && this.callbacks.onGroupNavigateUp && this.canNavigateUp && this.isClickOnGroupNavigateUp(group, pos.x, pos.y)) {
            this.callbacks.onGroupNavigateUp()
            this.scheduleRender()
            return
          }
          if (!this.readonly) {
            this.draggingGroupId = group.id
            this.placementGestureStartedAt = performance.now()
            this.placementPreviewUpdates = 0
            this.dragGroupStartPositions.clear()
            const groupObjects = this.objects.filter((o) => group.objectIds.includes(o.id))
            for (const o of groupObjects) {
              this.dragGroupStartPositions.set(o.id, { ...o.position })
            }
            this.dragGroupStartPosition = group.position ? { ...group.position } : { x: 0, y: 0 }
            const startBounds = this.getGroupBounds(group)
            this.dragGroupStartBounds = startBounds
              ? { id: group.id, ...startBounds }
              : null
            this.captureSmartGuideCandidates(new Set(group.objectIds), new Set([group.id]))
            this.dragOffset = { x: pos.x, y: pos.y }
          }
          this.callbacks.onObjectSelect(null, false)
          this.callbacks.onGroupSelect(group.id)
        } else {
          // Start background pan detection; actual deselect happens on mouseup if it was a click
          this.isBackgroundPanning = true
          this.backgroundPanMoved = false
          this.panStart = { x: e.clientX, y: e.clientY }
          this.viewportStart = { ...this.viewport }
          this.startInteraction()
        }
      }
    }
  }

  private onMouseMove = (e: MouseEvent) => {
    const pos = this.screenToWorld(e.offsetX, e.offsetY)

    // Start fast render mode during any interactive operation
    if (this.isPanning || this.isBackgroundPanning || this.draggingId || this.draggingGroupId || this.draggingCommentId || this.resizingId || this.isAnchorDragging || this.draggingConnEndpoint || this.isDraggingLabel || this.draggingWaypointConnId) {
      this.startInteraction()
    }

    if (this.isPanning) {
      this.viewport.x = this.viewportStart.x + (e.clientX - this.panStart.x)
      this.viewport.y = this.viewportStart.y + (e.clientY - this.panStart.y)
      this.scheduleRender()
      return
    }

    if (this.isBackgroundPanning) {
      const dx = e.clientX - this.panStart.x
      const dy = e.clientY - this.panStart.y
      const dist = Math.hypot(dx, dy)
      if (!this.backgroundPanMoved && dist > 3) {
        this.backgroundPanMoved = true
        this.canvas.style.cursor = 'grabbing'
      }
      if (this.backgroundPanMoved) {
        this.viewport.x = this.viewportStart.x + dx
        this.viewport.y = this.viewportStart.y + dy
        this.scheduleRender()
      }
      return
    }

    if (this.toolMode === 'connection' && this.connectionFrom) {
      this.connectionPreview = pos
      this.scheduleRender()
      return
    }

    if (this.isAnchorDragging) {
      this.connDragPreview = pos
      const hoveredObj = this.hitTest(pos.x, pos.y)
      const hoveredGroup = this.hitTestGroup(pos.x, pos.y)
      const newHoveredId = hoveredObj ? hoveredObj.id : (hoveredGroup ? hoveredGroup.id : null)
      let newAnchorIndex: number | null = null
      if (newHoveredId && newHoveredId !== this.connectionFrom) {
        newAnchorIndex = this.findNearestAnchor(newHoveredId, pos.x, pos.y)
      }
      if (this.hoveredId !== (hoveredObj ? hoveredObj.id : null) || this.hoveredGroupId !== (hoveredGroup ? hoveredGroup.id : null) || this.hoveredAnchorIndex !== newAnchorIndex) {
        this.hoveredId = hoveredObj ? hoveredObj.id : null
        this.hoveredGroupId = hoveredGroup ? hoveredGroup.id : null
        this.hoveredAnchorIndex = newAnchorIndex
        this.scheduleRender()
      } else {
        this.scheduleRender()
      }
      this.canvas.style.cursor = this.getCrosshairCursor()
      return
    }

    if (this.draggingConnEndpoint && this.draggingConnId) {
      this.connDragPreview = pos
      // Determine hovered shape/group for anchor drop target
      const hoveredObj = this.hitTest(pos.x, pos.y)
      const hoveredGroup = this.hitTestGroup(pos.x, pos.y)
      const newHoveredId = hoveredObj ? hoveredObj.id : (hoveredGroup ? hoveredGroup.id : null)
      if (this.hoveredAnchorShapeId !== newHoveredId) {
        this.hoveredAnchorShapeId = newHoveredId
        this.scheduleRender()
      } else {
        this.scheduleRender()
      }
      this.canvas.style.cursor = this.getCrosshairCursor()
      return
    }

    if (this.resizingId && this.resizeHandle) {
      const dx = pos.x - this.resizeStartMouse.x
      const dy = pos.y - this.resizeStartMouse.y
      const handle = this.resizeHandle

      if (this.resizingType === 'object') {
        const selectedObjectIds = this.getSelectedObjectIds()
        const isMulti = selectedObjectIds.length > 1 && this.resizeStartStates.size > 1

        if (isMulti) {
          // Multi-select proportional resize
          const anchor = this.getAnchorCorner(this.resizeStartBounds, handle)
          const scaleX = this.computeResizeScale(handle, dx, this.resizeStartBounds.w, 'x')
          const scaleY = this.computeResizeScale(handle, dy, this.resizeStartBounds.h, 'y')

          const objectUpdates: Array<{ id: string; position: Position; size: { width: number; height: number } }> = []
          for (const [id, start] of this.resizeStartStates) {
            const relX = start.x - anchor.x
            const relY = start.y - anchor.y
            const newX = anchor.x + relX * scaleX
            const newY = anchor.y + relY * scaleY
            const newW = Math.max(40, start.w * scaleX)
            const newH = Math.max(30, start.h * scaleY)
            objectUpdates.push({ id, position: { x: newX, y: newY }, size: { width: newW, height: newH } })
          }
          this.updatePlacements({ objects: objectUpdates })
        } else {
          // Single object resize
          const start = this.resizeStartStates.get(this.resizingId)
          if (start) {
            let newX = start.x, newY = start.y, newW = start.w, newH = start.h
            if (handle === 'se') {
              newW = Math.max(40, start.w + dx)
              newH = Math.max(30, start.h + dy)
            } else if (handle === 'sw') {
              newW = Math.max(40, start.w - dx)
              newH = Math.max(30, start.h + dy)
              newX = start.x + (start.w - newW)
            } else if (handle === 'ne') {
              newW = Math.max(40, start.w + dx)
              newH = Math.max(30, start.h - dy)
              newY = start.y + (start.h - newH)
            } else if (handle === 'nw') {
              newW = Math.max(40, start.w - dx)
              newH = Math.max(30, start.h - dy)
              newX = start.x + (start.w - newW)
              newY = start.y + (start.h - newH)
            }
            this.updatePlacements({
              objects: [{
                id: this.resizingId,
                position: { x: newX, y: newY },
                size: { width: newW, height: newH },
              }],
            })
          }
        }
      } else if (this.resizingType === 'group') {
        const start = this.resizeStartStates.get(this.resizingId)
        if (start) {
          let newX = start.x, newY = start.y, newW = start.w, newH = start.h
          if (handle === 'se') {
            newW = Math.max(40, start.w + dx)
            newH = Math.max(30, start.h + dy)
          } else if (handle === 'sw') {
            newW = Math.max(40, start.w - dx)
            newH = Math.max(30, start.h + dy)
            newX = start.x + (start.w - newW)
          } else if (handle === 'ne') {
            newW = Math.max(40, start.w + dx)
            newH = Math.max(30, start.h - dy)
            newY = start.y + (start.h - newH)
          } else if (handle === 'nw') {
            newW = Math.max(40, start.w - dx)
            newH = Math.max(30, start.h - dy)
            newX = start.x + (start.w - newW)
            newY = start.y + (start.h - newH)
          }
          this.updatePlacements({
            groups: [{
              id: this.resizingId,
              position: { x: newX, y: newY },
              size: { width: newW, height: newH },
              autoSize: false,
            }],
          })
        }
      }
      this.scheduleRender()
      return
    }

    if (this.draggingId) {
      this.dragMoved = true
      const newX = pos.x - this.dragOffset.x
      const newY = pos.y - this.dragOffset.y
      if (this.dragMultiStartPositions.size > 0) {
        const rawDx = newX - (this.dragMultiStartPositions.get(this.draggingId)?.x ?? newX)
        const rawDy = newY - (this.dragMultiStartPositions.get(this.draggingId)?.y ?? newY)
        const selectionBounds = unionGuideRects(
          [...this.dragMultiStartPositions].flatMap(([id, start]) => {
            const object = this.objectMap.get(id)
            return object ? [{ id, x: start.x + rawDx, y: start.y + rawDy, ...object.size }] : []
          }),
        )
        const correction = selectionBounds ? this.updateSmartGuides(selectionBounds) : { dx: 0, dy: 0 }
        const dx = rawDx + correction.dx
        const dy = rawDy + correction.dy
        this.updatePlacements({
          objects: [...this.dragMultiStartPositions].map(([id, start]) => ({
            id,
            position: { x: start.x + dx, y: start.y + dy },
          })),
        })
      } else {
        const object = this.objectMap.get(this.draggingId)
        const correction = object
          ? this.updateSmartGuides({ id: object.id, x: newX, y: newY, ...object.size })
          : { dx: 0, dy: 0 }
        this.updatePlacements({
          objects: [{ id: this.draggingId, position: { x: newX + correction.dx, y: newY + correction.dy } }],
        })
      }
      this.scheduleRender()
      return
    }

    if (this.draggingGroupId) {
      this.dragMoved = true
      const rawDx = pos.x - this.dragOffset.x
      const rawDy = pos.y - this.dragOffset.y
      const correction = this.dragGroupStartBounds
        ? this.updateSmartGuides({
          ...this.dragGroupStartBounds,
          x: this.dragGroupStartBounds.x + rawDx,
          y: this.dragGroupStartBounds.y + rawDy,
        })
        : { dx: 0, dy: 0 }
      const dx = rawDx + correction.dx
      const dy = rawDy + correction.dy
      const group = this.groups.find((g) => g.id === this.draggingGroupId)
      if (group) {
        const objectUpdates: Array<{ id: string; position: Position }> = []
        const groupUpdates: Array<{ id: string; position: Position }> = []
        const hasObjects = group.objectIds.length > 0
        if (hasObjects) {
          for (const obj of this.objects) {
            if (group.objectIds.includes(obj.id)) {
              const start = this.dragGroupStartPositions.get(obj.id)
              if (start) {
                const newX = start.x + dx
                const newY = start.y + dy
                objectUpdates.push({ id: obj.id, position: { x: newX, y: newY } })
              }
            }
          }
          if (group.position) {
            const newX = this.dragGroupStartPosition.x + dx
            const newY = this.dragGroupStartPosition.y + dy
            groupUpdates.push({ id: group.id, position: { x: newX, y: newY } })
          }
        } else if (group.position) {
          const newX = this.dragGroupStartPosition.x + dx
          const newY = this.dragGroupStartPosition.y + dy
          groupUpdates.push({ id: group.id, position: { x: newX, y: newY } })
        }
        this.updatePlacements({ objects: objectUpdates, groups: groupUpdates })
      }
      this.scheduleRender()
      return
    }

    // Comment drag
    if (this.draggingCommentId) {
      this.dragCommentMoved = true
      const newX = pos.x - this.dragCommentOffset.x
      const newY = pos.y - this.dragCommentOffset.y
      this.updateCommentPlacement(this.draggingCommentId, { x: newX, y: newY })
      return
    }

    // Waypoint (bend point) drag — move the grabbed dot, or materialize a pending one.
    if (this.draggingWaypointConnId && this.draggingWaypointIndex !== null && this.workingWaypoints) {
      this.workingWaypoints[this.draggingWaypointIndex] = { x: pos.x, y: pos.y }
      this.invalidateConnectionGeometry(this.draggingWaypointConnId)
      this.canvas.style.cursor = this.getCrosshairCursor()
      this.scheduleRender()
      return
    }
    if (this.pendingWaypoint) {
      const moved = Math.hypot(pos.x - this.pendingWaypoint.startX, pos.y - this.pendingWaypoint.startY)
      if (moved > 3 / this.viewport.scale) {
        const conn = this.connections.find((c) => c.id === this.pendingWaypoint!.connId)
        if (conn) {
          const wps = (conn.waypoints ?? []).map((p) => ({ ...p }))
          wps.splice(this.pendingWaypoint.index, 0, { x: pos.x, y: pos.y })
          this.workingWaypoints = wps
          this.draggingWaypointConnId = this.pendingWaypoint.connId
          this.draggingWaypointIndex = this.pendingWaypoint.index
          this.invalidateConnectionGeometry(this.pendingWaypoint.connId)
        }
        this.pendingWaypoint = null
        this.canvas.style.cursor = this.getCrosshairCursor()
        this.scheduleRender()
      }
      return
    }

    // Label drag — project mouse onto the connection path, compute position + perpendicular offset
    if (this.isDraggingLabel && this.draggingLabelConnId) {
      const conn = this.connections.find((c) => c.id === this.draggingLabelConnId)
      const geom = conn ? this.getConnectionGeometry(conn) : null
      if (geom) {
        const t = this.findNearestTOnPath(geom, pos.x, pos.y)
        this.dragLabelCurrentT = t

        // Compute perpendicular offset from the path at this t
        const pt = this.getPathPoint(geom, t)
        const tangent = this.getPathTangent(geom, t)
        // Normal is perpendicular to tangent: rotate 90° CCW → (-dy, dx)
        const normalX = -tangent.y
        const normalY = tangent.x
        const rawOffset = (pos.x - pt.x) * normalX + (pos.y - pt.y) * normalY
        // Clamp offset to keep label snapped near the line (max 40 world units)
        this.dragLabelCurrentOffset = Math.max(-40, Math.min(40, rawOffset))

        this.scheduleRender()
      }
      this.canvas.style.cursor = 'grabbing'
      return
    }

    // Copy mode cursor override
    if (this.copyMode) {
      this.copyCursorPos = { x: pos.x, y: pos.y }
      this.canvas.style.cursor = this.copyMode === 'size' ? 'copy' : 'alias'
      // Resolve the same target set the click would, so the tooltip can say how
      // many shapes are about to change. Silently restyling a selection the
      // user has stopped thinking about is the failure mode this prevents.
      this.copyTargetCount = this.copyTargetsAt(pos.x, pos.y).length
      this.scheduleRender()
      return
    }

    // Hovering a bend-point dot of the selected connection → show crosshair cursor.
    if (!this.readonly && this.hitTestWaypointDot(pos.x, pos.y)) {
      this.canvas.style.cursor = this.getCrosshairCursor()
      return
    }

    // Hovering an endpoint dot (source/target) of the selected connection → show crosshair cursor.
    if (!this.readonly && this.hitTestAnchorDot(pos.x, pos.y)) {
      this.canvas.style.cursor = this.getCrosshairCursor()
      return
    }

    // Check resize handle hover (highest priority for cursor)
    const resizeHandleHit = this.hitTestResizeHandle(pos.x, pos.y)
    if (resizeHandleHit) {
      if (!this.hoveredResizeHandle || this.hoveredResizeHandle.handle !== resizeHandleHit.handle) {
        this.hoveredResizeHandle = resizeHandleHit
        this.scheduleRender()
      }
      const cursorMap = { nw: 'nw-resize', ne: 'ne-resize', sw: 'sw-resize', se: 'se-resize' }
      this.canvas.style.cursor = cursorMap[resizeHandleHit.handle]
      this.copyCursorPos = { x: pos.x, y: pos.y }
      // Clear other hovers
      if (this.hoveredId || this.hoveredGroupId || this.hoveredConnectionId || this.hoveredAnchorIndex !== null || this.hoveredGroupExpandId || this.hoveredGroupNavigateId) {
        this.hoveredId = null
        this.hoveredGroupId = null
        this.hoveredConnectionId = null
        this.hoveredLinkId = null
        this.hoveredExpandId = null
        this.hoveredGroupExpandId = null
        this.hoveredGroupNavigateId = null
        this.hoveredAnchorIndex = null
        this.scheduleRender()
      }
      return
    } else if (this.hoveredResizeHandle) {
      this.hoveredResizeHandle = null
      this.scheduleRender()
    }

    const obj = this.hitTest(pos.x, pos.y)
    if (obj) {
      const isLinkHovered = this.isClickOnLinkIndicator(obj, pos.x, pos.y)
      const isExpandHovered = obj.type !== 'actor' && this.isClickOnExpandIndicator(obj, pos.x, pos.y)
      let anchorHit: { shapeId: string; anchorIndex: number } | null = null
      if (!isLinkHovered && !isExpandHovered) {
        anchorHit = this.hitTestShapeAnchor(obj.id, pos.x, pos.y)
      }
      // When a connection is selected, suppress shape hover anchors if mouse is on the connection's endpoint dot
      const isOnEndpointDot = this.getSingleSelectedConnectionId() ? this.hitTestAnchorDot(pos.x, pos.y) !== null : false
      if (isOnEndpointDot) {
        anchorHit = null
      }
      if (
        this.hoveredId !== obj.id ||
        this.hoveredConnectionId ||
        this.hoveredLinkId !== (isLinkHovered ? obj.id : null) ||
        this.hoveredExpandId !== (isExpandHovered ? obj.id : null) ||
        this.hoveredGroupId !== null ||
        this.hoveredAnchorIndex !== (anchorHit ? anchorHit.anchorIndex : null)
      ) {
        this.hoveredId = obj.id
        this.hoveredGroupId = null
        this.hoveredConnectionId = null
        this.hoveredLinkId = isLinkHovered ? obj.id : null
        this.hoveredExpandId = isExpandHovered ? obj.id : null
        this.hoveredAnchorIndex = anchorHit ? anchorHit.anchorIndex : null
        this.canvas.style.cursor = isLinkHovered || isExpandHovered ? 'pointer' : (anchorHit ? this.getCrosshairCursor() : 'default')
        this.scheduleRender()
      }
    } else {
      // Check if mouse is near any shape's anchor (even if not over the shape)
      let anchorHit: { shapeId: string; anchorIndex: number } | null = null

      // When a connection is selected, suppress shape hover anchors if mouse is on the connection's endpoint dot
      const isOnEndpointDot = this.getSingleSelectedConnectionId() ? this.hitTestAnchorDot(pos.x, pos.y) !== null : false

      if (!isOnEndpointDot) {
        // First check previously hovered shape/group (most common case)
        if (this.hoveredId) {
          anchorHit = this.hitTestShapeAnchor(this.hoveredId, pos.x, pos.y)
        }
        if (!anchorHit && this.hoveredGroupId) {
          anchorHit = this.hitTestShapeAnchor(this.hoveredGroupId, pos.x, pos.y)
        }

        // Anchors sit on a shape's edges and hit within 10/scale, so only shapes
        // whose bounds come that close to the cursor can answer; the spatial
        // indexes narrow every scan below to those, in the same topmost-first order.
        const reach = 10 / this.viewport.scale
        const near: SpatialBounds = { x: pos.x - reach, y: pos.y - reach, width: reach * 2, height: reach * 2 }

        // Then check all visible objects (reverse order for z-index)
        if (!anchorHit) {
          for (const i of [...this.ensureObjectSpatialIndex().query(near)].sort((a, b) => b - a)) {
            const obj = this.objects[i]
            if (!obj) continue
            if (this.isObjectHidden(obj)) continue
            if (obj.id === this.hoveredId) continue
            const hit = this.hitTestShapeAnchor(obj.id, pos.x, pos.y)
            if (hit) {
              anchorHit = hit
              break
            }
          }
        }

        // Then check all groups
        if (!anchorHit) {
          for (const i of [...this.ensureGroupSpatialIndex().query(near)].sort((a, b) => b - a)) {
            const g = this.groups[i]
            if (!g) continue
            if (g.id === this.hoveredGroupId) continue
            const hit = this.hitTestShapeAnchor(g.id, pos.x, pos.y)
            if (hit) {
              anchorHit = hit
              break
            }
          }
        }
      }

      if (anchorHit) {
        const isObj = this.objectMap.has(anchorHit.shapeId)
        if (this.hoveredId !== (isObj ? anchorHit.shapeId : null) || this.hoveredGroupId !== (isObj ? null : anchorHit.shapeId) || this.hoveredConnectionId || this.hoveredLinkId || this.hoveredExpandId || this.hoveredAnchorIndex !== anchorHit.anchorIndex) {
          this.hoveredId = isObj ? anchorHit.shapeId : null
          this.hoveredGroupId = isObj ? null : anchorHit.shapeId
          this.hoveredConnectionId = null
          this.hoveredLinkId = null
          this.hoveredExpandId = null
          this.hoveredGroupExpandId = null
          this.hoveredGroupNavigateId = null
          this.hoveredAnchorIndex = anchorHit.anchorIndex
          this.canvas.style.cursor = this.getCrosshairCursor()
          this.scheduleRender()
        }
      } else {
        // Check group hover
        const group = this.hitTestGroup(pos.x, pos.y)
        if (group) {
          const isParentWrapper = !!group.parentObjectId
          const isGroupExpandHovered = isParentWrapper && this.isClickOnGroupExpandIndicator(group, pos.x, pos.y)
          const isGroupNavHovered = isParentWrapper && this.canNavigateUp && this.isClickOnGroupNavigateUp(group, pos.x, pos.y)
          const groupAnchorHit = this.hitTestShapeAnchor(group.id, pos.x, pos.y)
          const shouldShowPointer = isGroupExpandHovered || isGroupNavHovered || !!groupAnchorHit

          if (
            this.hoveredGroupId !== group.id ||
            this.hoveredId !== null ||
            this.hoveredConnectionId ||
            this.hoveredAnchorIndex !== (groupAnchorHit ? groupAnchorHit.anchorIndex : null) ||
            this.hoveredGroupExpandId !== (isGroupExpandHovered ? group.id : null) ||
            this.hoveredGroupNavigateId !== (isGroupNavHovered ? group.id : null)
          ) {
            this.hoveredGroupId = group.id
            this.hoveredId = null
            this.hoveredConnectionId = null
            this.hoveredLinkId = null
            this.hoveredExpandId = null
            this.hoveredGroupExpandId = isGroupExpandHovered ? group.id : null
            this.hoveredGroupNavigateId = isGroupNavHovered ? group.id : null
            this.hoveredAnchorIndex = groupAnchorHit ? groupAnchorHit.anchorIndex : null
            this.canvas.style.cursor = groupAnchorHit ? this.getCrosshairCursor() : (shouldShowPointer ? 'pointer' : 'default')
            this.scheduleRender()
          }
        } else {
          // Check if hovering over a connection label
          const labelConn = this.hitTestConnectionLabel(pos.x, pos.y)
          if (labelConn) {
            if (this.hoveredLabelConnId !== labelConn.id || this.hoveredId || this.hoveredGroupId || this.hoveredConnectionId || this.hoveredAnchorIndex !== null) {
              this.hoveredLabelConnId = labelConn.id
              this.hoveredConnectionId = null
              this.hoveredId = null
              this.hoveredGroupId = null
              this.hoveredLinkId = null
              this.hoveredExpandId = null
              this.hoveredGroupExpandId = null
              this.hoveredGroupNavigateId = null
              this.hoveredAnchorIndex = null
              this.canvas.style.cursor = 'grab'
              this.scheduleRender()
            }
          } else {
            // Check if hovering over a connection
            const conn = this.hitTestConnection(pos.x, pos.y)
            if (conn) {
              if (this.hoveredConnectionId !== conn.id || this.hoveredId || this.hoveredGroupId || this.hoveredLabelConnId || this.hoveredAnchorIndex !== null) {
                this.hoveredConnectionId = conn.id
                this.hoveredLabelConnId = null
                this.hoveredId = null
                this.hoveredGroupId = null
                this.hoveredLinkId = null
                this.hoveredExpandId = null
                this.hoveredGroupExpandId = null
                this.hoveredGroupNavigateId = null
                this.hoveredAnchorIndex = null
                this.canvas.style.cursor = 'pointer'
                this.scheduleRender()
              }
            } else {
              if (this.hoveredId || this.hoveredGroupId || this.hoveredConnectionId || this.hoveredLabelConnId || this.hoveredLinkId || this.hoveredExpandId || this.hoveredAnchorIndex !== null) {
                this.hoveredId = null
                this.hoveredGroupId = null
                this.hoveredConnectionId = null
                this.hoveredLabelConnId = null
                this.hoveredLinkId = null
                this.hoveredExpandId = null
                this.hoveredGroupExpandId = null
                this.hoveredGroupNavigateId = null
                this.hoveredAnchorIndex = null
                this.canvas.style.cursor = this.toolMode === 'pan' ? 'grab' : 'default'
                this.scheduleRender()
              }
            }
          }
        }
      }
    }
  }

  private onMouseUp = () => {
    if (this.isBackgroundPanning) {
      if (!this.backgroundPanMoved) {
        // It was a click on empty space → deselect
        this.callbacks.onObjectSelect(null, false)
      }
      this.isBackgroundPanning = false
      this.backgroundPanMoved = false
      this.canvas.style.cursor = this.toolMode === 'pan' ? 'grab' : 'default'
    }
    // Anchor drag completion
    if (this.isAnchorDragging && this.connectionFrom) {
      const targetId = this.hoveredId || this.hoveredGroupId
      if (targetId && targetId !== this.connectionFrom) {
        const targetType = this.hoveredId ? 'object' : 'group'
        const toAnchor = this.hoveredAnchorIndex ?? undefined
        this.callbacks.onConnectionEnd(targetId, targetType, toAnchor)
      }
      this.isAnchorDragging = false
      this.connectionFrom = null
      this.connectionFromAnchor = null
      this.hoveredAnchorIndex = null
      this.scheduleRender()
    }

    // Connection endpoint drag completion
    if (this.draggingConnEndpoint && this.draggingConnId) {
      if (this.hoveredAnchorShapeId) {
        const conn = this.connections.find((c) => c.id === this.draggingConnId)
        if (conn) {
          const targetId = this.hoveredAnchorShapeId
          const nearestAnchor = this.findNearestAnchor(targetId, this.connDragPreview.x, this.connDragPreview.y)
          if (nearestAnchor !== null) {
            this.callbacks.onConnectionAnchorMove(this.draggingConnId, this.draggingConnEndpoint, targetId, nearestAnchor)
          }
        }
      }
      this.draggingConnEndpoint = null
      this.draggingConnId = null
      this.hoveredAnchorShapeId = null
      this.scheduleRender()
    }

    // Handle link indicator click: single link → new tab, multiple links → open sidebar
    if (this.linkIndicatorClickedId && !this.dragMoved) {
      const obj = this.objects.find((o) => o.id === this.linkIndicatorClickedId)
      if (obj?.links) {
        if (obj.links.length === 1 && obj.links[0]) {
          const href = safeExternalHref(obj.links[0])
          if (href) window.open(href, '_blank', 'noopener,noreferrer')
        } else if (obj.links.length > 1) {
          useUIStore.setState({ rightSidebarOpen: true })
        }
      }
    }

    // Snap to grid on drag end
    if (this.snapToGrid && this.dragMoved) {
      const snappedObjects: Array<{ id: string; position: Position; size?: { width: number; height: number } }> = []
      const snappedGroups: Array<{ id: string; position?: Position; size?: { width: number; height: number }; autoSize?: boolean }> = []
      if (this.resizingId && this.resizingType === 'object') {
        const snap = this.gridSize / 2
        const selectedObjectIds = this.getSelectedObjectIds()
        const ids = (selectedObjectIds.length > 1 && this.resizeStartStates.size > 1)
          ? Array.from(this.resizeStartStates.keys())
          : [this.resizingId]
        for (const id of ids) {
          const obj = this.objects.find((o) => o.id === id)
          if (obj) {
            const snappedX = Math.round(obj.position.x / snap) * snap
            const snappedY = Math.round(obj.position.y / snap) * snap
            const snappedW = Math.max(40, Math.round(obj.size.width / snap) * snap)
            const snappedH = Math.max(30, Math.round(obj.size.height / snap) * snap)
            snappedObjects.push({
              id,
              position: { x: snappedX, y: snappedY },
              size: { width: snappedW, height: snappedH },
            })
          }
        }
      }
      if (this.resizingId && this.resizingType === 'group') {
        const snap = this.gridSize / 2
        const group = this.groups.find((g) => g.id === this.resizingId)
        if (group && group.position && group.size) {
          const snappedX = Math.round(group.position.x / snap) * snap
          const snappedY = Math.round(group.position.y / snap) * snap
          const snappedW = Math.max(40, Math.round(group.size.width / snap) * snap)
          const snappedH = Math.max(30, Math.round(group.size.height / snap) * snap)
          snappedGroups.push({
            id: this.resizingId,
            position: { x: snappedX, y: snappedY },
            size: { width: snappedW, height: snappedH },
            autoSize: false,
          })
        }
      }
      if (this.draggingId) {
        if (this.dragMultiStartPositions.size > 0) {
          const snap = this.gridSize / 2
          for (const id of this.dragMultiStartPositions.keys()) {
            const obj = this.objects.find((o) => o.id === id)
            if (obj) {
              const snappedX = this.smartGuideSnap.x ? obj.position.x : Math.round(obj.position.x / snap) * snap
              const snappedY = this.smartGuideSnap.y ? obj.position.y : Math.round(obj.position.y / snap) * snap
              snappedObjects.push({ id, position: { x: snappedX, y: snappedY } })
            }
          }
        } else {
          const obj = this.objects.find((o) => o.id === this.draggingId)
          if (obj) {
            const snap = this.gridSize / 2
            const snappedX = this.smartGuideSnap.x ? obj.position.x : Math.round(obj.position.x / snap) * snap
            const snappedY = this.smartGuideSnap.y ? obj.position.y : Math.round(obj.position.y / snap) * snap
            snappedObjects.push({ id: this.draggingId, position: { x: snappedX, y: snappedY } })
          }
        }
      }
      if (this.draggingGroupId) {
        const group = this.groups.find((g) => g.id === this.draggingGroupId)
        if (group) {
          const snap = this.gridSize / 2
          // Snap group position too
          if (group.position) {
            const snappedGroupX = this.smartGuideSnap.x ? group.position.x : Math.round(group.position.x / snap) * snap
            const snappedGroupY = this.smartGuideSnap.y ? group.position.y : Math.round(group.position.y / snap) * snap
            snappedGroups.push({ id: group.id, position: { x: snappedGroupX, y: snappedGroupY } })
          }
          for (const obj of this.objects) {
            if (group.objectIds.includes(obj.id)) {
              const snappedX = this.smartGuideSnap.x ? obj.position.x : Math.round(obj.position.x / snap) * snap
              const snappedY = this.smartGuideSnap.y ? obj.position.y : Math.round(obj.position.y / snap) * snap
              snappedObjects.push({ id: obj.id, position: { x: snappedX, y: snappedY } })
            }
          }
        }
      }
      this.updatePlacements({ objects: snappedObjects, groups: snappedGroups })
    }

    // Persist exactly once after the final snapped preview is in place.
    if (this.dragMoved) {
      const objectUpdates: Array<{ id: string; position: Position; size?: { width: number; height: number } }> = []
      const groupUpdates: Array<{ id: string; position?: Position; size?: { width: number; height: number }; autoSize?: boolean }> = []
      if (this.resizingId && this.resizingType === 'object') {
        const ids = this.resizeStartStates.size > 1
          ? [...this.resizeStartStates.keys()]
          : [this.resizingId]
        for (const id of ids) {
          const object = this.objectMap.get(id)
          if (object) objectUpdates.push({ id, position: { ...object.position }, size: { ...object.size } })
        }
      } else if (this.resizingId && this.resizingType === 'group') {
        const group = this.groupMap.get(this.resizingId)
        if (group?.position && group.size) {
          groupUpdates.push({
            id: group.id,
            position: { ...group.position },
            size: { ...group.size },
            autoSize: false,
          })
        }
      } else if (this.draggingId) {
        const ids = this.dragMultiStartPositions.size > 0
          ? [...this.dragMultiStartPositions.keys()]
          : [this.draggingId]
        for (const id of ids) {
          const object = this.objectMap.get(id)
          if (object) objectUpdates.push({ id, position: { ...object.position } })
        }
      } else if (this.draggingGroupId) {
        const group = this.groupMap.get(this.draggingGroupId)
        if (group?.position) groupUpdates.push({ id: group.id, position: { ...group.position } })
        for (const objectId of group?.objectIds ?? []) {
          const object = this.objectMap.get(objectId)
          if (object) objectUpdates.push({ id: object.id, position: { ...object.position } })
        }
      }
      this.commitPlacements({ objects: objectUpdates, groups: groupUpdates })
    }

    // Label drag completion
    if (this.isDraggingLabel && this.draggingLabelConnId) {
      this.callbacks.onConnectionLabelMove?.(this.draggingLabelConnId, this.dragLabelCurrentT, this.dragLabelCurrentOffset)
    }

    // Waypoint drag completion — commit the new bend points to the store.
    // (The store round-trips back through setData(); store objects are frozen by
    // immer, so we must not mutate the engine's local copy directly.)
    if (this.draggingWaypointConnId && this.workingWaypoints) {
      this.callbacks.onConnectionWaypointsChange(this.draggingWaypointConnId, this.workingWaypoints.map((p) => ({ ...p })))
    }
    this.draggingWaypointConnId = null
    this.draggingWaypointIndex = null
    this.workingWaypoints = null
    this.pendingWaypoint = null

    // Comment drag completion
    if (this.draggingCommentId) {
      if (!this.dragCommentMoved) {
        // It was a click, not a drag — open the comment
        const comment = this.comments.find((c) => c.id === this.draggingCommentId)
        if (comment) {
          const screen = this.worldToScreen(comment.position.x, comment.position.y)
          this.callbacks.onCommentClick(comment.id, screen.x, screen.y)
        }
      } else {
        // Finalize drag position (snap to grid if enabled)
        let comment = this.commentMap.get(this.draggingCommentId)
        if (comment && this.snapToGrid) {
          const snap = this.gridSize / 2
          const snappedX = Math.round(comment.position.x / snap) * snap
          const snappedY = Math.round(comment.position.y / snap) * snap
          this.updateCommentPlacement(this.draggingCommentId, { x: snappedX, y: snappedY })
          comment = this.commentMap.get(this.draggingCommentId)
        }
        if (comment) {
          this.callbacks.onCommentMove(
            this.draggingCommentId,
            comment.position.x,
            comment.position.y,
          )
        }
      }
      this.draggingCommentId = null
      this.dragCommentMoved = false
    }

    this.isPanning = false
    this.draggingId = null
    this.lastGestureMoved = this.dragMoved
    this.dragMoved = false
    this.linkIndicatorClickedId = null
    this.draggingGroupId = null
    this.dragGroupStartBounds = null
    this.dragGroupStartPositions.clear()
    this.dragMultiStartPositions.clear()
    this.clearSmartGuides()
    this.resizingId = null
    this.resizingType = null
    this.resizeHandle = null
    this.resizeStartStates.clear()
    this.placementGestureStartedAt = 0
    this.placementPreviewUpdates = 0
    this.isDraggingLabel = false
    this.draggingLabelConnId = null
    if (this.toolMode === 'pan') {
      this.canvas.style.cursor = 'grab'
    }
    this.endInteraction()
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.startInteraction()
    // Debounce end of wheel interaction — there's no native "wheel end" event
    if (this.wheelTimeoutId) clearTimeout(this.wheelTimeoutId)
    this.wheelTimeoutId = window.setTimeout(() => {
      this.wheelTimeoutId = 0
      this.endInteraction()
    }, 200)
    // Trackpad horizontal two-finger scroll → pan horizontally
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.viewport.x -= e.deltaX
      this.scheduleRender()
      return
    }
    // Smooth zoom proportional to deltaY (works for both mouse wheel and trackpad)
    const zoomSpeed = 0.001
    const newScale = Math.max(0.1, Math.min(4, this.viewport.scale * Math.exp(-e.deltaY * zoomSpeed)))
    const mouseWorldBefore = this.screenToWorld(e.offsetX, e.offsetY)
    this.viewport.scale = newScale
    const mouseWorldAfter = this.screenToWorld(e.offsetX, e.offsetY)
    this.viewport.x += (mouseWorldAfter.x - mouseWorldBefore.x) * newScale
    this.viewport.y += (mouseWorldAfter.y - mouseWorldBefore.y) * newScale
    this.scheduleRender()
    this.callbacks.onZoom(newScale)
  }

  private onDoubleClick = (e: MouseEvent) => {
    const pos = this.screenToWorld(e.offsetX, e.offsetY)

    // Double-click a waypoint dot to remove it (reverting that bend).
    if (!this.readonly) {
      const wpHit = this.hitTestWaypointDot(pos.x, pos.y)
      if (wpHit) {
        const conn = this.connections.find((c) => c.id === wpHit.connId)
        if (conn) {
          const next = (conn.waypoints ?? []).filter((_, i) => i !== wpHit.index)
          this.callbacks.onConnectionWaypointsChange(conn.id, next)
        }
        return
      }
    }

    // Everything below OPENS AN EDITOR, so it is gated the way editing is.
    if (this.readonly) return
    // A flow being played is a presentation, not an editing surface — mirrors
    // the same guard on mousedown.
    if (!this.flowEditMode && this.currentFlowId) return
    // Copy mode consumed click 1 and disarmed, so click 2 arrives here as an
    // ordinary double-click the user did not intend.
    if (this.copyMode) return
    // A double-click that ends a drag is a drag, not an edit. `dragMoved` is
    // already cleared by `onMouseUp` before this fires, hence the carried copy.
    if (this.lastGestureMoved) return

    const object = this.hitTest(pos.x, pos.y, { skipHidden: true })
    // Shapes render ON TOP of connections, so an object under the cursor wins —
    // the same priority mousedown and the context menu already use. Without
    // this, `hitTestConnection`'s tolerance band (12 / scale) makes any shape
    // with a line routed near its title unreachable: the user aims at the title
    // and gets the connection-label editor instead.
    if (!object) {
      // A group's text band is a small, exact rectangle, so it beats the
      // connection tolerance band for the same reason a shape does. The rest of
      // a group's box does NOT: it is the members' space, and a double-click
      // there must still reach a line routed across it.
      const hit = this.groupTextHitAt(pos.x, pos.y)
      if (hit) {
        this.callbacks.onGroupDoubleClick(hit.id, hit.band, e.offsetX, e.offsetY)
        return
      }
      const conn = this.hitTestConnection(pos.x, pos.y)
      if (conn) {
        this.callbacks.onConnectionDoubleClick(conn.id, e.offsetX, e.offsetY)
        return
      }
      return
    }

    this.callbacks.onObjectDoubleClick(
      object.id,
      this.objectTextBandAt(object.id, pos.x, pos.y),
      e.offsetX,
      e.offsetY,
    )
  }

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    const pos = this.screenToWorld(e.offsetX, e.offsetY)
    // Shapes render on top of connections, so an object under the cursor wins over
    // the connection line/label beneath it (matches left-click selection priority).
    const obj = this.hitTest(pos.x, pos.y)
    if (obj) {
      this.callbacks.onContextMenu(e.clientX, e.clientY, obj.id, null, null, this.selectedItems)
      return
    }
    const conn = this.hitTestConnection(pos.x, pos.y)
    if (conn) {
      this.callbacks.onContextMenu(e.clientX, e.clientY, null, null, conn.id, this.selectedItems)
      return
    }
    const group = this.hitTestGroup(pos.x, pos.y)
    if (group) {
      this.callbacks.onContextMenu(e.clientX, e.clientY, null, group.id, null, this.selectedItems)
      return
    }
    this.callbacks.onContextMenu(e.clientX, e.clientY, null, null, null, this.selectedItems)
  }

  private hitTestGroup(x: number, y: number): Group | null {
    // Check groups in reverse order (topmost first)
    const candidates = [...this.ensureGroupSpatialIndex().query({ x, y, width: 0, height: 0 })]
      .sort((a, b) => b - a)
    for (const i of candidates) {
      const group = this.groups[i]
      const bounds = this.getGroupBounds(group)
      if (!bounds) continue

      if (
        x >= bounds.x &&
        x <= bounds.x + bounds.width &&
        y >= bounds.y &&
        y <= bounds.y + bounds.height
      ) {
        return group
      }
    }
    return null
  }

  // --- Rendering ---

  private renderLoop() {
    const hasConnectionAnim =
      this.isInFocusMode() &&
      this.connectionAnimationsEnabled &&
      this.connectionHighlightStyle !== 'none'

    // Theme-driven animation (e.g. cyberpunk glow/glitch) keeps the loop alive.
    const themeAnimating = this.themeBridge.isAnimating()
    // After a layered frame (see render) everything but the highlight effects is
    // frozen in two bitmaps. Until something else changes, an animation frame
    // re-composites those and redraws the effects alone; with no effect visible
    // (a selection whose connections are all off-screen) there is nothing left
    // to animate, so the loop goes idle instead of repainting an unchanged scene.
    const layersHold = this.animLayersValid && !this.needsRender && !themeAnimating
    const needsAnim = hasConnectionAnim || themeAnimating
    if (layersHold && hasConnectionAnim) {
      if (this.animEffects.length > 0) this.renderAnimationFrame()
    } else if (this.needsRender || needsAnim) {
      const frameStartedAt = performance.now()
      const finishFrame = startClientTimelineMeasure('canvas.frame', { animated: needsAnim })
      this.render()
      const frameDurationMs = performance.now() - frameStartedAt
      if (this.frameQuality.record(frameDurationMs)) {
        markClientTimeline('canvas.quality.changed', {
          degraded: this.frameQuality.isDegraded(),
          frameDurationMs,
        })
      }
      finishFrame({
        objects: this.objects.length,
        connections: this.connections.length,
        groups: this.groups.length,
        objectsDrawn: this.lastFrameStats.objectsDrawn,
        objectsCulled: this.objects.length - this.lastFrameStats.objectsDrawn,
        connectionsDrawn: this.lastFrameStats.connectionsDrawn,
        connectionsCulled: this.connections.length - this.lastFrameStats.connectionsDrawn,
        groupsDrawn: this.lastFrameStats.groupsDrawn,
        groupsCulled: this.groups.length - this.lastFrameStats.groupsDrawn,
        lowZoomLod: this.lastFrameStats.lowZoomLod,
        adaptiveQuality: this.frameQuality.isDegraded(),
      })
      if (this.renderedDataRevision !== this.dataRevision) {
        this.renderedDataRevision = this.dataRevision
        markClientTimeline('canvas.first-frame-after-data', {
          objects: this.objects.length,
          connections: this.connections.length,
          groups: this.groups.length,
        })
      }
      this.needsRender = false
    }

    // Only keep the loop alive while there is active animation or a pending render.
    // When idle, the loop stops and will be restarted on the next scheduleRender() call.
    // Re-evaluated after the frame: the render that just ran may have found no
    // visible effect to animate.
    const keepAnimating = this.themeBridge.isAnimating()
      || (hasConnectionAnim && !(this.animLayersValid && this.animEffects.length === 0))
    if (keepAnimating) {
      this.rafId = requestAnimationFrame(() => this.renderLoop())
    } else {
      this.rafId = 0
    }
  }

  private startRenderLoop() {
    this.rafId = requestAnimationFrame(() => this.renderLoop())
  }

  /**
   * Whether this frame may freeze the scene around the highlight effects. Only
   * when those effects are the ONLY thing that changes with time: no theme
   * animation, no time-driven neon pulse on the selection, no community sandbox
   * reading per-frame snapshots, and not mid-gesture (every gesture frame is a
   * full render anyway, so splitting it would only add two copies).
   */
  private canLayerConnectionEffects(): boolean {
    return this.isInFocusMode()
      && this.connectionAnimationsEnabled
      && this.connectionHighlightStyle !== 'none'
      && !this.isInteracting
      && !this.frameQuality.isDegraded()
      && !this.themeBridge.isAnimating()
      && !this.themeBridge.wantsSnapshot()
      && !this.skin.renderStyle.neonGlow?.enabled
      && typeof document !== 'undefined'
  }

  private ensureAnimLayer(layer: HTMLCanvasElement | null): HTMLCanvasElement {
    const canvas = layer ?? document.createElement('canvas')
    if (canvas.width !== this.canvas.width) canvas.width = this.canvas.width
    if (canvas.height !== this.canvas.height) canvas.height = this.canvas.height
    return canvas
  }

  private drawDeferredEffects(ctx: CanvasRenderingContext2D) {
    for (const { geom, alpha } of this.animEffects) {
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.setLineDash([])
      this.renderConnectionHighlightEffect(ctx, geom)
      ctx.restore()
    }
  }

  /** Composite the frozen layers around freshly drawn highlight effects. */
  private renderAnimationFrame() {
    const under = this.animUnderLayer
    const over = this.animOverLayer
    if (!under || !over) return
    this.connectionAnimationTime = Date.now()
    const ctx = this.ctx
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.drawImage(under, 0, 0)
    ctx.restore()
    ctx.save()
    ctx.translate(this.viewport.x, this.viewport.y)
    ctx.scale(this.viewport.scale, this.viewport.scale)
    this.drawDeferredEffects(ctx)
    ctx.restore()
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(over, 0, 0)
    ctx.restore()
  }

  private isInViewport(bounds: { x: number; y: number; width: number; height: number }, padding = 0): boolean {
    return this.boundsIntersect(bounds, this.getViewportWorldBounds(padding))
  }

  private getViewportWorldBounds(padding = 0): SpatialBounds {
    const viewLeft = -this.viewport.x / this.viewport.scale
    const viewTop = -this.viewport.y / this.viewport.scale
    return {
      x: viewLeft - padding,
      y: viewTop - padding,
      width: (this.canvas.width / this.dpr) / this.viewport.scale + padding * 2,
      height: (this.canvas.height / this.dpr) / this.viewport.scale + padding * 2,
    }
  }

  private boundsIntersect(a: SpatialBounds, b: SpatialBounds): boolean {
    return a.x + a.width >= b.x && a.x <= b.x + b.width
      && a.y + a.height >= b.y && a.y <= b.y + b.height
  }

  private ensureObjectSpatialIndex(): SpatialGridIndex<number> {
    if (this.objectSpatialIndex) return this.objectSpatialIndex
    const index = new SpatialGridIndex<number>(CanvasEngine.SHAPE_GRID_CELL)
    for (let objectIndex = 0; objectIndex < this.objects.length; objectIndex += 1) {
      const object = this.objects[objectIndex]
      index.insert({
        x: object.position.x,
        y: object.position.y,
        width: object.size.width,
        height: object.size.height,
      }, objectIndex)
    }
    this.objectSpatialIndex = index
    return index
  }

  private ensureGroupSpatialIndex(): SpatialGridIndex<number> {
    if (this.groupSpatialIndex) return this.groupSpatialIndex
    const index = new SpatialGridIndex<number>(CanvasEngine.SHAPE_GRID_CELL)
    for (let groupIndex = 0; groupIndex < this.groups.length; groupIndex += 1) {
      const bounds = this.getGroupBounds(this.groups[groupIndex])
      if (bounds) index.insert(bounds, groupIndex)
    }
    this.groupSpatialIndex = index
    return index
  }

  private getVisibleObjects(padding = 0): C4Object[] {
    const viewport = this.getViewportWorldBounds(padding)
    const indices = [...this.ensureObjectSpatialIndex().query(viewport)].sort((a, b) => a - b)
    const visible: C4Object[] = []
    for (const index of indices) {
      const object = this.objects[index]
      if (!object) continue
      const bounds = { x: object.position.x, y: object.position.y, width: object.size.width, height: object.size.height }
      if (this.boundsIntersect(bounds, viewport)) visible.push(object)
    }
    return visible
  }

  private getVisibleGroups(padding = 0): Group[] {
    const viewport = this.getViewportWorldBounds(padding)
    const indices = [...this.ensureGroupSpatialIndex().query(viewport)].sort((a, b) => a - b)
    const visible: Group[] = []
    for (const index of indices) {
      const group = this.groups[index]
      const bounds = group ? this.getGroupBounds(group) : null
      if (group && bounds && this.boundsIntersect(bounds, viewport)) visible.push(group)
    }
    return visible
  }

  private usesLowZoomLod(): boolean {
    return this.viewport.scale < CanvasEngine.LOW_ZOOM_LOD
  }

  /** Build the per-frame screen-space RenderContext handed to theme seam hooks. */
  private buildScreenRenderContext(width: number, height: number): RenderContext {
    const vp = this.viewport
    return {
      space: 'screen',
      viewport: { x: vp.x, y: vp.y, scale: vp.scale },
      dpr: this.dpr,
      canvas: { width, height },
      timeMs: this.connectionAnimationTime,
      fastMode: this.isInteracting,
      anim: this.frameAnim,
      style: this.skin.renderStyle,
      worldToScreen: (p) => ({ x: p.x * vp.scale + vp.x, y: p.y * vp.scale + vp.y }),
      screenToWorld: (p) => ({ x: (p.x - vp.x) / vp.scale, y: (p.y - vp.y) / vp.scale }),
      rng: createRng,
    }
  }

  private render() {
    this.connectionAnimationTime = Date.now()
    this.frameAnim = this.themeBridge.sampleAnim(this.connectionAnimationTime)
    const mainCtx = this.ctx
    // Switched to the "over" layer after the connection lines in a layered frame.
    let ctx = mainCtx
    const width = this.canvas.width / this.dpr
    const height = this.canvas.height / this.dpr

    const layered = this.canLayerConnectionEffects()
    const screenTransform = layered ? mainCtx.getTransform() : null
    this.deferredEffects = layered && screenTransform ? [] : null
    this.animEffects = []
    this.animLayersValid = false

    ctx.clearRect(0, 0, width, height)

    // Background seam: a theme may replace the flat fill; cyberpunk adds a
    // screen-space scan-line overlay as a `post` hook (drawn behind the world).
    this.frameRenderContext = this.buildScreenRenderContext(width, height)
    const bgArgs: BackgroundArgs = { ctx: this.frameRenderContext, width, height, bg: this.skin.canvas.bg }
    if (!this.themeBridge.runSeam('background', ctx as unknown as Draw, bgArgs)) {
      ctx.fillStyle = this.skin.canvas.bg
      ctx.fillRect(0, 0, width, height)
    }
    this.themeBridge.runSeamPost('background', ctx as unknown as Draw, bgArgs)

    // Ship the scene to the community sandbox worker (no-op for trusted themes).
    if (this.themeBridge.wantsSnapshot()) {
      this.themeBridge.postFrame(this.buildFrameSnapshot(width, height))
    }

    ctx.save()
    ctx.translate(this.viewport.x, this.viewport.y)
    ctx.scale(this.viewport.scale, this.viewport.scale)

    const visibleGroups = this.getVisibleGroups(100)
    const visibleConnections = this.getVisibleConnections(100)
    const visibleObjects = this.getVisibleObjects(100).filter((object) => !this.isObjectHidden(object))
    this.lastFrameStats = {
      objectsDrawn: visibleObjects.length,
      groupsDrawn: visibleGroups.length,
      connectionsDrawn: visibleConnections.length,
      lowZoomLod: this.usesLowZoomLod(),
    }

    // Grid in world space (anchored to the world, moves with objects)
    if (this.showGrid && !this.readonly) {
      this.renderGridWorld(ctx, width, height)
    }

    // Groups (rendered behind everything)
    for (const group of visibleGroups) {
      this.renderGroup(ctx, group)
    }

    // Connections: lines + labels + highlight effects (first pass)
    for (const conn of visibleConnections) {
      this.renderConnection(ctx, conn)
    }

    // Layered frame: freeze what is drawn so far as the "under" layer and draw
    // everything above the effects into a transparent "over" layer. The effects
    // are composited between the two at the end of this frame and on every
    // animation frame after it (renderAnimationFrame), so animating the
    // selection no longer repaints the whole scene (3.3 → 0.5 ms per frame at
    // zoom 1, ≤ 6/255 from the single-layer render; measured with bench/canvas2d).
    // Effects are drawn above ALL
    // connection lines rather than interleaved with them, which keeps an animated
    // highlight from being cut by an unrelated line crossing it.
    const deferredEffects = this.deferredEffects
    this.deferredEffects = null
    let overLayer: HTMLCanvasElement | null = null
    if (deferredEffects && deferredEffects.length > 0) {
      const under = this.ensureAnimLayer(this.animUnderLayer)
      const over = this.ensureAnimLayer(this.animOverLayer)
      this.animUnderLayer = under
      this.animOverLayer = over
      const underCtx = under.getContext('2d')
      const overCtx = over.getContext('2d')
      if (underCtx && overCtx) {
        underCtx.setTransform(1, 0, 0, 1, 0, 0)
        underCtx.clearRect(0, 0, under.width, under.height)
        underCtx.drawImage(this.canvas, 0, 0)
        overCtx.setTransform(1, 0, 0, 1, 0, 0)
        overCtx.clearRect(0, 0, over.width, over.height)
        overCtx.setTransform(mainCtx.getTransform())
        overLayer = over
        ctx = overCtx
      }
    }

    // Connection overlays: anchors + arrowheads (second pass, drawn on top of
    // all lines so one connection's line never covers another's arrowhead).
    // Both passes run *before* objects so shapes always sit above connections.
    for (const conn of visibleConnections) {
      const geom = this.getConnectionGeometry(conn)
      if (!geom) continue
      if (this.usesLowZoomLod() && !geom.isHighlighted && !geom.isHovered) continue
      if (!this.readonly) {
        this.renderConnectionSourceAnchors(ctx, conn)
      }
      this.renderConnectionArrowheads(ctx, conn)
      if (!this.readonly) {
        this.renderConnectionDestinationAnchors(ctx, conn)
        this.renderConnectionWaypoints(ctx, conn)
      }
    }

    // Connection preview (connection tool mode only — anchor drag has its own preview)
    if (this.connectionFrom && !this.isAnchorDragging) {
      this.renderConnectionPreview(ctx, this.connectionFrom, this.connectionPreview)
    }

    // Objects (skip hidden unless hovering a hidden tag)
    for (const obj of visibleObjects) {
      this.renderObject(ctx, obj)
    }

    this.renderSmartGuides(ctx)

    // Shape hover anchors (hidden in readonly mode)
    if (!this.readonly && !this.isAnchorDragging && !this.draggingId && !this.draggingGroupId && !this.draggingConnEndpoint) {
      if (this.hoveredId) {
        this.renderShapeAnchors(ctx, this.hoveredId, { hoveredIndex: this.hoveredAnchorIndex })
      } else if (this.hoveredGroupId) {
        this.renderShapeAnchors(ctx, this.hoveredGroupId, { hoveredIndex: this.hoveredAnchorIndex })
      }
    }

    // Anchor drag preview and target anchors
    if (this.isAnchorDragging && this.connectionFrom) {
      this.renderAnchorDragPreview(ctx)
      if (this.hoveredId && this.hoveredId !== this.connectionFrom) {
        this.renderShapeAnchors(ctx, this.hoveredId, {
          hoveredIndex: this.hoveredAnchorIndex,
          highlightedIndex: this.hoveredAnchorIndex ?? undefined,
        })
      } else if (this.hoveredGroupId && this.hoveredGroupId !== this.connectionFrom) {
        this.renderShapeAnchors(ctx, this.hoveredGroupId, {
          hoveredIndex: this.hoveredAnchorIndex,
          highlightedIndex: this.hoveredAnchorIndex ?? undefined,
        })
      }
    }

    // Connection endpoint drag preview and anchor dots (rendered on top of objects)
    if (this.draggingConnEndpoint && this.draggingConnId) {
      this.renderConnectionEndpointDragPreview(ctx)
      if (this.hoveredAnchorShapeId) {
        const conn = this.connections.find((c) => c.id === this.draggingConnId)
        let skipIdx: number | undefined
        if (this.hoveredAnchorShapeId === (this.draggingConnEndpoint === 'source' ? conn?.fromId : conn?.toId)) {
          skipIdx = this.draggingConnEndpoint === 'source' ? conn?.fromAnchor : conn?.toAnchor
          // In unlock mode, compute the nearest anchor to the current edge point
          if (skipIdx === undefined && conn) {
            const from = this.getConnectionEndpoint(conn.fromId, conn.lockedToAnchors ? conn.fromAnchor : undefined)
            const to = this.getConnectionEndpoint(conn.toId, conn.lockedToAnchors ? conn.toAnchor : undefined)
            if (from && to) {
              if (this.draggingConnEndpoint === 'source') {
                const edge = this.getEdgePoint(from.cx, from.cy, to.cx, to.cy, from.width, from.height)
                const nearest = this.findNearestAnchor(conn.fromId, edge.x, edge.y)
                if (nearest !== null) skipIdx = nearest
              } else {
                const edge = this.getEdgePoint(to.cx, to.cy, from.cx, from.cy, to.width, to.height)
                const nearest = this.findNearestAnchor(conn.toId, edge.x, edge.y)
                if (nearest !== null) skipIdx = nearest
              }
            }
          }
        }
        this.renderAnchorDotsForShape(ctx, this.hoveredAnchorShapeId, this.connDragPreview.x, this.connDragPreview.y, skipIdx)
      }
    }

    // Resize handles (rendered on top of everything)
    this.renderResizeHandles(ctx)

    // Flow step overlays (process badge, information card)
    if (this.currentFlowId) {
      this.renderFlowStepOverlays(ctx)
    }

    // Copy mode tooltip
    if (this.copyMode) {
      this.renderCopyTooltip(ctx)
    }

    if (overLayer && deferredEffects && screenTransform) {
      // Comment bubbles (screen space, on top of everything) belong to the over layer.
      ctx.setTransform(screenTransform)
      this.renderCommentBubbles(ctx)
      // The main canvas still holds the under layer, in world space.
      this.animEffects = deferredEffects
      this.drawDeferredEffects(mainCtx)
      mainCtx.restore()
      mainCtx.save()
      mainCtx.setTransform(1, 0, 0, 1, 0, 0)
      mainCtx.drawImage(overLayer, 0, 0)
      mainCtx.restore()
      this.animLayersValid = true
      return
    }

    // Effects were deferred but no layer could be created: draw them in place,
    // and leave the layers invalid so the loop keeps repainting in full.
    if (deferredEffects && deferredEffects.length > 0) {
      this.animEffects = deferredEffects
      this.drawDeferredEffects(ctx)
      this.animEffects = []
    }

    ctx.restore()

    // Comment bubbles (rendered in screen space, on top of everything)
    this.renderCommentBubbles(ctx)
    // A layerable frame with no visible effect has nothing left to animate.
    if (deferredEffects && deferredEffects.length === 0) this.animLayersValid = true
  }

  private renderCopyTooltip(ctx: CanvasRenderingContext2D) {
    const base = this.copyMode === 'size' ? i18n.t('canvasEngine.copySize') : i18n.t('canvasEngine.copyStyle')
    // Only announce a count when it is more than the shape being pointed at.
    // "Copy style · 1" would be noise on the ordinary single-shape paste.
    const label = this.copyTargetCount > 1
      ? i18n.t('canvasEngine.copyToShapes', { label: base, n: this.copyTargetCount })
      : base
    // A modifier nobody is told about is not a feature. The hint rides on the
    // cursor because that is where the user is looking while the mode is armed,
    // and the mode is transient enough that a settings-level explanation would
    // never be read.
    const hint = i18n.t('canvasEngine.copyChainHint')
    const x = this.copyCursorPos.x + 12
    const y = this.copyCursorPos.y - 12
    const padding = 6
    ctx.font = this.getCanvasFont('bold', 12)
    const labelWidth = ctx.measureText(label).width
    ctx.font = this.getCanvasFont('400', 10)
    const hintWidth = ctx.measureText(hint).width
    const w = Math.max(labelWidth, hintWidth) + padding * 2
    const h = 34

    // Background pill
    ctx.save()
    ctx.fillStyle = this.copyMode === 'size' ? this.skin.copyCursor.sizeColor : this.skin.copyCursor.styleColor
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 4)
    ctx.fill()

    // Text
    ctx.fillStyle = this.skin.copyCursor.text
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.font = this.getCanvasFont('bold', 12)
    ctx.fillText(label, x + padding, y + 12)
    ctx.globalAlpha = 0.75
    ctx.font = this.getCanvasFont('400', 10)
    ctx.fillText(hint, x + padding, y + 25)
    ctx.restore()
  }

  /** Freeze guide targets for the gesture so snapping remains stable while the
   * moving selection updates the live placement maps. */
  private captureSmartGuideCandidates(
    excludedObjectIds: Set<string>,
    excludedGroupIds = new Set<string>(),
  ): void {
    const candidates: GuideRect[] = []
    for (const object of this.objects) {
      if (excludedObjectIds.has(object.id) || this.isObjectHidden(object)) continue
      candidates.push({ id: object.id, x: object.position.x, y: object.position.y, ...object.size })
    }
    for (const group of this.groups) {
      if (
        excludedGroupIds.has(group.id) ||
        group.objectIds.some((id) => excludedObjectIds.has(id))
      ) continue
      const bounds = this.getGroupBounds(group)
      if (bounds) candidates.push({ id: group.id, ...bounds })
    }
    this.smartGuideCandidates = candidates
    this.smartGuides = []
    this.smartGuideSnap = { x: false, y: false }
    if (import.meta.env.DEV) {
      delete this.canvas.dataset.smartGuidesCurrent
      delete this.canvas.dataset.smartGuidesLast
    }
  }

  private updateSmartGuides(moving: GuideRect): { dx: number; dy: number } {
    const result = calculateSmartGuides(
      moving,
      this.smartGuideCandidates,
      6 / Math.max(this.viewport.scale, 0.01),
    )
    this.smartGuides = result.guides
    this.smartGuideSnap = { x: result.snappedX, y: result.snappedY }
    if (import.meta.env.DEV) {
      const probe = JSON.stringify({ guides: result.guides, snapped: this.smartGuideSnap })
      this.canvas.dataset.smartGuidesCurrent = probe
      if (result.guides.length > 0) this.canvas.dataset.smartGuidesLast = probe
    }
    return { dx: result.dx, dy: result.dy }
  }

  private clearSmartGuides(): void {
    this.smartGuideCandidates = []
    this.smartGuides = []
    this.smartGuideSnap = { x: false, y: false }
    if (import.meta.env.DEV) delete this.canvas.dataset.smartGuidesCurrent
  }

  private renderSmartGuides(ctx: CanvasRenderingContext2D): void {
    if (this.smartGuides.length === 0) return
    const scale = Math.max(this.viewport.scale, 0.01)
    const cap = 5 / scale
    const extension = 8 / scale
    const color = this.skin.selection.stroke

    ctx.save()
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 1.25 / scale
    ctx.setLineDash([4 / scale, 3 / scale])
    ctx.globalAlpha = 0.95

    for (const guide of this.smartGuides) {
      ctx.beginPath()
      if (guide.kind === 'alignment') {
        if (guide.axis === 'x') {
          ctx.moveTo(guide.value, guide.from - extension)
          ctx.lineTo(guide.value, guide.to + extension)
        } else {
          ctx.moveTo(guide.from - extension, guide.value)
          ctx.lineTo(guide.to + extension, guide.value)
        }
        ctx.stroke()
        continue
      }

      if (guide.axis === 'x') {
        ctx.moveTo(guide.start, guide.cross)
        ctx.lineTo(guide.end, guide.cross)
        ctx.moveTo(guide.start, guide.cross - cap)
        ctx.lineTo(guide.start, guide.cross + cap)
        ctx.moveTo(guide.end, guide.cross - cap)
        ctx.lineTo(guide.end, guide.cross + cap)
      } else {
        ctx.moveTo(guide.cross, guide.start)
        ctx.lineTo(guide.cross, guide.end)
        ctx.moveTo(guide.cross - cap, guide.start)
        ctx.lineTo(guide.cross + cap, guide.start)
        ctx.moveTo(guide.cross - cap, guide.end)
        ctx.lineTo(guide.cross + cap, guide.end)
      }
      ctx.stroke()

      const label = String(Math.round(guide.distance))
      const labelX = guide.axis === 'x' ? (guide.start + guide.end) / 2 : guide.cross + 10 / scale
      const labelY = guide.axis === 'x' ? guide.cross - 9 / scale : (guide.start + guide.end) / 2
      ctx.setLineDash([])
      ctx.font = this.getCanvasFont('bold', 10 / scale)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const width = ctx.measureText(label).width + 6 / scale
      ctx.fillStyle = this.skin.connections.labelBg
      ctx.fillRect(labelX - width / 2, labelY - 7 / scale, width, 14 / scale)
      ctx.fillStyle = color
      ctx.fillText(label, labelX, labelY)
      ctx.setLineDash([4 / scale, 3 / scale])
      ctx.fillStyle = color
    }
    ctx.restore()
  }

  private renderGridWorld(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const scale = this.viewport.scale
    const spacing = this.getGridSpacing(scale)

    // Visible world bounds
    const worldMinX = (-this.viewport.x) / scale
    const worldMinY = (-this.viewport.y) / scale
    const worldMaxX = (width - this.viewport.x) / scale
    const worldMaxY = (height - this.viewport.y) / scale

    const startX = Math.floor(worldMinX / spacing) * spacing
    const startY = Math.floor(worldMinY / spacing) * spacing

    // Keep dot size roughly 1.5 screen pixels regardless of zoom
    const radius = Math.min(2.5, Math.max(0.5, 1.5 / scale))

    ctx.fillStyle = this.skin.canvas.grid
    for (let x = startX; x <= worldMaxX; x += spacing) {
      for (let y = startY; y <= worldMaxY; y += spacing) {
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  private getGridSpacing(scale: number): number {
    let spacing = this.gridSize
    while (spacing * scale < 12) spacing *= 2
    return spacing
  }

  getGroupBounds(group: Group): { x: number; y: number; width: number; height: number } | null {
    if (this.groupBoundsCache.has(group.id)) return this.groupBoundsCache.get(group.id)!
    const result = this.computeGroupBounds(group)
    this.groupBoundsCache.set(group.id, result)
    return result
  }

  /**
   * Bounds of a group by id, resolved from the engine's OWN copy.
   *
   * Callers outside the engine must use this rather than
   * `getGroupBounds(theirGroup)`. `useModelStore.groups` holds the MODEL group,
   * whose `position`/`size` are the create-time values — the diagram's real
   * geometry lives in `diagram.layouts[groupId]` and is merged in only on the
   * way to the engine (`filterAndMergeDiagramData`). Passing the store's group
   * therefore computes bounds for a box the user is not looking at, and on a
   * cache miss caches that wrong answer under the id, corrupting the engine's
   * own bounds until the next `setData`.
   */
  getGroupBoundsById(id: string): { x: number; y: number; width: number; height: number } | null {
    const group = this.groupMap.get(id)
    return group ? this.getGroupBounds(group) : null
  }

  /**
   * An object's size as DRAWN, by id — the same reason `getGroupBoundsById`
   * exists.
   *
   * `useModelStore.objects` carries the create-time size; a resize on a diagram
   * is written to `diagram.layouts[id]` (`writePlacement`) and never back to
   * the object, and the merge happens only on the way here
   * (`filterAndMergeDiagramData`). So Copy size reading `objects.find(id).size`
   * copies the size the shape had when it was created, not the one on screen.
   */
  getObjectSizeById(id: string): { width: number; height: number } | null {
    const object = this.objectMap.get(id)
    return object ? { width: object.size.width, height: object.size.height } : null
  }

  private computeGroupBounds(group: Group): { x: number; y: number; width: number; height: number } | null {
    const isParentWrapper = !!group.parentObjectId
    // A parent-wrapper boundary always hugs its members (the parent object's
    // children), so it grows/shrinks as they move and a member can never sit
    // outside it. A stored size from import/auto-layout must not freeze it.
    // Standalone groups still honor an explicit manual size.
    if (group.autoSize === false && group.position && group.size && !isParentWrapper) {
      return {
        x: group.position.x,
        y: group.position.y,
        width: group.size.width,
        height: group.size.height,
      }
    }
    const groupObjects: C4Object[] = []
    for (const objectId of group.objectIds) {
      const object = this.objectMap.get(objectId)
      if (object) groupObjects.push(object)
    }
    if (groupObjects.length === 0) {
      if (group.position && group.size) {
        return {
          x: group.position.x,
          y: group.position.y,
          width: group.size.width,
          height: group.size.height,
        }
      }
      // A parent-wrapper boundary hugs its members; with none present it correctly has no box.
      if (isParentWrapper) return null
      // A standalone group with no members on this diagram and no stored geometry must still be
      // VISIBLE as a labeled drop target — otherwise an existing group added to a diagram (e.g. a
      // "— Data" group whose members live on another diagram) silently vanishes. Render a default
      // box at its position (or the origin) so the user can see and populate it.
      const pos = group.position ?? { x: 0, y: 0 }
      const size = group.size ?? { width: 240, height: 160 }
      return { x: pos.x, y: pos.y, width: size.width, height: size.height }
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const obj of groupObjects) {
      minX = Math.min(minX, obj.position.x)
      minY = Math.min(minY, obj.position.y)
      maxX = Math.max(maxX, obj.position.x + obj.size.width)
      maxY = Math.max(maxY, obj.position.y + obj.size.height)
    }

    const padding = 30
    // Parent wrappers reserve a centered top band for the identity stack
    // (icon → title → type → description) and a slim bottom padding; standard groups
    // reserve GROUP_STD_HEADER_PAD on top for their top-left icon + title row (so the
    // row clears the first member with a comfortable gap) and keep the symmetric 30px
    // pad on the other three sides. The band is sized so members never overlap the header.
    const topPadding = isParentWrapper ? this.groupHeaderBandHeight(group) : GROUP_STD_HEADER_PAD
    const bottomPadding = isParentWrapper ? GROUP_FOOTER_PAD : padding

    // The box must be wide enough for its header text (title + — for parent
    // wrappers — type/description, all centered). When the members are narrower,
    // grow the box symmetrically so they stay centered under the header.
    let x = minX - padding
    let width = maxX - minX + padding * 2
    const minContentWidth = isParentWrapper
      ? this.measureGroupHeaderMinWidth(group)
      : this.measureGroupTitleMinWidth(group)
    if (minContentWidth > width) {
      const extra = minContentWidth - width
      x -= extra / 2
      width = minContentWidth
    }

    return {
      x,
      y: minY - topPadding,
      width,
      height: maxY - minY + topPadding + bottomPadding,
    }
  }

  /** Minimum box width for a standard group's top-left title row (left padding +
   *  measured title + right padding). Returns 0 when there's no name. Mirrors the
   *  offsets `renderGroup` uses so the title never overflows. Font restored after. */
  private measureGroupTitleMinWidth(group: Group): number {
    const name = group.name?.trim()
    if (!name) return 0
    const ctx = this.ctx
    const prevFont = ctx.font
    ctx.font = this.getCanvasFont('500', 11, 'Inter', 'groupTitle')
    const left = group.icon ? 40 : 12 // iconPad(12) + iconSize(20) + iconGap(8)
    const right = 12
    const titleWidth = ctx.measureText(name).width
    ctx.font = prevFont
    return left + titleWidth + right
  }

  /** Height of the reserved top band for a parent-wrapper's centered header, sized
   *  to the present elements at base font (the tallest they get — the fitted stack
   *  only ever shrinks). Reserving exactly this in computeGroupBounds guarantees the
   *  rendered stack never overlaps the members. No text measurement — presence +
   *  base line heights only — so it's cheap and identical between bounds and render. */
  private groupHeaderBandHeight(group: Group): number {
    let stack = 0
    if (group.icon) stack += HDR_ICON + HDR_GAP_ICON
    if (group.name?.trim()) stack += Math.round(HDR_TITLE_BASE * 1.25)
    if (group.type?.trim()) stack += HDR_GAP_TYPE + Math.round(HDR_TYPE * 1.3)
    if (group.description?.trim()) stack += HDR_GAP_DESC + Math.round(HDR_DESC_BASE * 1.3)
    if (stack === 0) return MIN_HEADER_BAND
    return Math.max(MIN_HEADER_BAND, HDR_TOP_INSET + stack + HDR_BOTTOM_INSET)
  }

  /** Minimum box width for a parent-wrapper's centered header: the widest of the
   *  (capped) title / type / description, plus side insets — but never narrower
   *  than the top row of corner affordances (back/up left, expand + link badge
   *  right). Measured at base font sizes; the header font-fit shrinks anything that
   *  exceeds the cap. Font restored after. */
  private measureGroupHeaderMinWidth(group: Group): number {
    const ctx = this.ctx
    const prevFont = ctx.font
    const name = group.name?.trim() || ''
    const type = group.type?.trim() || ''
    const desc = group.description?.trim() || ''
    let textW = 0
    if (name) {
      ctx.font = this.getCanvasFont('600', HDR_TITLE_BASE, 'Inter', 'groupTitle')
      textW = Math.max(textW, ctx.measureText(name).width)
    }
    if (type) {
      ctx.font = this.getCanvasFont('500', HDR_TYPE, 'Inter')
      textW = Math.max(textW, ctx.measureText(type).width)
    }
    if (desc) {
      ctx.font = this.getCanvasFont('400', HDR_DESC_BASE, 'Inter')
      textW = Math.max(textW, ctx.measureText(desc).width)
    }
    ctx.font = prevFont
    const contentW = Math.min(textW, HDR_MAX_TEXT_W) + HDR_PAD_X * 2
    // Top-row corner affordances must not collide: back/up icon (left) and the
    // expand icon + optional link badge (right), with a minimum centre gap.
    const leftRow = this.canNavigateUp ? 28 : 12
    const parentObj = group.parentObjectId ? this.objectMap.get(group.parentObjectId) : undefined
    const rightRow = 16 + (parentObj?.links?.length ? 30 : 0) + 12
    return Math.max(contentW, leftRow + rightRow + 16)
  }

  /** Build (and memoize) the fitted, truncated layout of a parent-wrapper's
   *  centered header for a known box width. Title and description adapt their font
   *  to the box (shrink to a floor, then ellipsize); type is a fixed small line.
   *  Keyed by content + width + font identity so the per-frame render path is a
   *  single Map hit. `this.ctx.font` is restored before returning. */
  private getGroupHeaderLayout(group: Group, boxWidth: number): GroupHeaderLayout {
    const name = group.name?.trim() || ''
    const type = group.type?.trim() || ''
    const desc = group.description?.trim() || ''
    const key = `${group.id}|${name}|${type}|${desc}|${Math.round(boxWidth)}|${this.skin.id}|${group.icon ?? ''}|${this.canNavigateUp ? 1 : 0}`
    const cached = this.groupHeaderCache.get(key)
    if (cached) return cached

    const ctx = this.ctx
    const prevFont = ctx.font
    const maxW = Math.max(0, boxWidth - HDR_PAD_X * 2)

    let titleText = ''
    let titleSize = HDR_TITLE_BASE
    if (name) {
      titleSize = this.getFittedFontSize(ctx, name, maxW, HDR_TITLE_BASE, HDR_TITLE_MIN, '600', 'groupTitle')
      ctx.font = this.getCanvasFont('600', titleSize, 'Inter', 'groupTitle')
      titleText = this.truncateText(ctx, name, maxW)
    }

    let typeText = ''
    if (type) {
      ctx.font = this.getCanvasFont('500', HDR_TYPE, 'Inter')
      typeText = this.truncateText(ctx, type, maxW)
    }

    let descText = ''
    let descSize = HDR_DESC_BASE
    if (desc) {
      descSize = this.getFittedFontSize(ctx, desc, maxW, HDR_DESC_BASE, HDR_DESC_MIN, '400')
      ctx.font = this.getCanvasFont('400', descSize, 'Inter')
      descText = this.truncateText(ctx, desc, maxW)
    }

    ctx.font = prevFont

    const hasIcon = !!group.icon
    const titleLineH = Math.round(titleSize * 1.25)
    const typeLineH = Math.round(HDR_TYPE * 1.3)
    const descLineH = Math.round(descSize * 1.3)
    let stackHeight = 0
    if (hasIcon) stackHeight += HDR_ICON + HDR_GAP_ICON
    if (titleText) stackHeight += titleLineH
    if (typeText) stackHeight += HDR_GAP_TYPE + typeLineH
    if (descText) stackHeight += HDR_GAP_DESC + descLineH

    const layout: GroupHeaderLayout = {
      titleText, titleSize, titleLineH,
      typeText, typeLineH,
      descText, descSize, descLineH,
      hasIcon, stackHeight,
    }
    this.groupHeaderCache.set(key, layout)
    return layout
  }

  /** Draw a group's box (fill + plain stroke). Themes override via the `group`
   *  seam; this is the default-skin fallback for both group kinds. */
  private drawGroupBox(ctx: CanvasRenderingContext2D, args: GroupArgs, isSelected: boolean) {
    if (this.themeBridge.runSeam('group', ctx as unknown as Draw, args)) return
    const { x, y, w, h, cornerRadius: r } = args.geom
    if (args.isParentWrapper) {
      ctx.fillStyle = args.fill
      buildRoundRectPath(ctx, x, y, w, h, r)
      ctx.fill()
      ctx.strokeStyle = args.stroke
      ctx.lineWidth = isSelected ? 2 : 1
      ctx.stroke()
    } else {
      const lw = (args.strokeWidth || 1) + (isSelected ? 1 : 0)
      // Fill the full box first (skipped for a transparent background).
      if (args.fillAlpha > 0) {
        buildRoundRectPath(ctx, x, y, w, h, r)
        ctx.fillStyle = args.fill
        ctx.globalAlpha = args.fillAlpha
        ctx.fill()
      }
      // Draw the border INSIDE the box (like CSS border-box) so it stays flush
      // against the fill and never extends past the bounds — a centered stroke
      // would straddle the edge and, when thick + semi-transparent, read as a
      // washed-out gap that grows with the width. This inset path is left
      // current so the selection glow follows the same outline.
      const inset = lw / 2
      buildRoundRectPath(ctx, x + inset, y + inset, w - lw, h - lw, Math.max(0, r - inset))
      ctx.globalAlpha = args.strokeAlpha
      ctx.strokeStyle = args.stroke
      ctx.lineWidth = lw
      ctx.stroke()
    }
  }

  /** Selection glow stroking the current path (theme-agnostic, data-driven). */
  private strokeGroupSelectionGlow(ctx: CanvasRenderingContext2D) {
    const neonGlow = this.skin.renderStyle.neonGlow
    const glowPulse = neonGlow?.enabled
      ? 1 + Math.sin(Date.now() / neonGlow.pulseSpeed) * 0.25 * neonGlow.intensity
      : 1
    strokeSelectionGlow(ctx, this.skin.selection.glow, 5 * glowPulse)
  }

  private renderGroup(ctx: CanvasRenderingContext2D, group: Group) {
    const fastMode = this.isInteracting
    const bounds = this.getGroupBounds(group)
    if (!bounds) return

    const x = bounds.x
    const y = bounds.y
    const w = bounds.width
    const h = bounds.height
    const r = 12
    const isSelected = this.isGroupSelected(group.id)
    const isParentWrapper = !!group.parentObjectId

    ctx.save()

    const groupStroke = isParentWrapper
      ? (isSelected ? this.skin.selection.stroke : this.skin.groups.navColor)
      : (isSelected ? this.skin.selection.stroke : (group.borderColor || group.color || this.skin.groups.navColor))
    const groupFill = isParentWrapper
      ? this.skin.groups.parentWrapperFill
      : (group.color || '#F1F5F9')
    // Fill/stroke opacity is data-driven: the group may override the fill alpha
    // (or make the background fully transparent); the stroke alpha follows the
    // skin's standard/selected values. Parent wrappers keep their solid look.
    const gAlpha = this.skin.groups
    const customColors = !isParentWrapper && !!(group.color || group.borderColor)
    const fillAlpha = isParentWrapper
      ? 1
      : (group.fillTransparent ? 0 : (group.fillOpacity ?? gAlpha.standardFillAlpha ?? 0.3))
    // A user-chosen border renders crisp/opaque (matching the picker preview);
    // the faded standard alpha is only for the default group look. Drawing a
    // thick, semi-transparent centered stroke over the fill otherwise reads as a
    // washed-out gap that widens with the border size.
    const strokeAlpha = isParentWrapper
      ? 1
      : (isSelected
          ? (gAlpha.standardStrokeSelectedAlpha ?? 0.9)
          : (customColors ? 1 : (gAlpha.standardStrokeAlpha ?? 0.5)))
    const groupArgs: GroupArgs = {
      ctx: this.frameRenderContext!,
      id: group.id,
      isParentWrapper,
      geom: { x, y, w, h, cornerRadius: r },
      state: { selected: isSelected },
      fill: groupFill,
      stroke: groupStroke,
      fillAlpha,
      strokeAlpha,
      strokeWidth: isParentWrapper ? 0 : (group.borderWidth ?? 0),
      customColors,
    }

    if (this.usesLowZoomLod() && !isSelected && this.hoveredGroupId !== group.id) {
      this.drawGroupBox(ctx, groupArgs, false)
      if (!isParentWrapper) this.renderGroupBottomBar(ctx, group, groupArgs.geom)
      // No text was painted, so the last frame's rect is a lie. Objects tolerate
      // a stale one because a missed band still opens their title; a group with
      // no band opens nothing, so a stale rect here would open a rename over
      // text that is not on screen.
      this.groupTextBounds.delete(group.id)
      ctx.restore()
      return
    }

    // Group box seam — themes own fill/border/double via the `group` hook; the
    // default path draws fill + plain stroke. The selection glow strokes whatever
    // path the box left (theme-agnostic, skipped for pixel-snap themes).
    this.drawGroupBox(ctx, groupArgs, isSelected)
    if (!fastMode && isSelected && !this.themeBridge.pixelSnap) {
      this.strokeGroupSelectionGlow(ctx)
    }

    if (isParentWrapper) {
      // Interactive affordances sit in the top corners (their hit areas are pinned
      // to the box corners — see isClickOnGroupExpandIndicator / NavigateUp); the
      // identity stack is centered below them so they never collide.
      const cornerY = y + 14

      // Top-left: back/up icon (navigate to the parent diagram) + hover label.
      if (this.canNavigateUp) {
        const isGroupNavHovered = this.hoveredGroupNavigateId === group.id
        const navColor = isGroupNavHovered ? this.skin.groups.navColorHover : this.skin.groups.navColor
        this.renderBackIcon(ctx, x + 14, cornerY, 10, navColor)
        if (isGroupNavHovered) {
          ctx.fillStyle = this.skin.groups.backText
          ctx.font = this.getCanvasFont('500', 10)
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          ctx.fillText(i18n.t('canvasEngine.back'), x + 28, cornerY)
        }
      }

      // Top-right: expand when another diagram exists. The create affordance is
      // contextual: only reveal it while hovering the wrapper in edit mode.
      const isGroupExpandHovered = this.hoveredGroupExpandId === group.id
      const groupExpandColor = isGroupExpandHovered ? this.skin.groups.expandColorHover : this.skin.groups.expandColor
      if (this.relatedDiagramObjectIds.has(group.parentObjectId!)) {
        this.renderExpandIcon(ctx, x + w - 16, cornerY, 10, groupExpandColor)
      } else if (!this.readonly && this.hoveredGroupId === group.id) {
        this.renderPlusIcon(ctx, x + w - 16, cornerY, 10, groupExpandColor)
      }

      // Top-right: link count if the parent object has links (left of the expand icon).
      const parentObj = group.parentObjectId ? this.objectMap.get(group.parentObjectId) : undefined
      if (parentObj && parentObj.links && parentObj.links.length > 0) {
        const linkX = x + w - 12 - 24
        ctx.fillStyle = this.skin.groups.linkColor
        ctx.font = this.getCanvasFont('500', 11)
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(parentObj.links.length), linkX - 14, cornerY)

        ctx.strokeStyle = this.skin.groups.linkColor
        ctx.lineWidth = 1.5
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        ctx.moveTo(linkX - 10, cornerY - 3)
        ctx.lineTo(linkX - 6, cornerY + 3)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(linkX - 6, cornerY - 3)
        ctx.lineTo(linkX - 10, cornerY + 3)
        ctx.stroke()
      }

      // Centered identity stack (icon → title → type → description), top-aligned
      // within the reserved top band — the band hugs the stack (groupHeaderBandHeight)
      // so this reads centered, and HDR_TOP_INSET keeps every line below the corner
      // hit zones. Fonts + truncation are precomputed and memoized
      // (getGroupHeaderLayout) so this stays a cache lookup per frame.
      const hdr = this.getGroupHeaderLayout(group, w)
      // Built and stored ONCE per frame, never read back out of the map to be
      // amended. Amending whatever `get(group.id)` returned would let a wrapper
      // with a description and no name record nothing (its painted description
      // unreachable), and let a wrapper that LOST its name keep the previous
      // frame's title rect with this frame's description merged into it.
      const painted: ObjectTextBounds = { title: EMPTY_TEXT_RECT, description: null }
      if (hdr.stackHeight > 0) {
        const cx = x + w / 2
        let cur = y + HDR_TOP_INSET
        ctx.textAlign = 'center'
        // The header is centered on `cx`, so a band is measured from the middle
        // outwards. Capped at the box because a fitted line never exceeds it.
        const bandWidth = Math.min(HDR_MAX_TEXT_W, Math.max(0, w - HDR_PAD_X * 2))
        const bandX = cx - bandWidth / 2

        if (hdr.hasIcon) {
          this.renderTechnologyIcon(ctx, group, cx, cur + HDR_ICON / 2)
          cur += HDR_ICON + HDR_GAP_ICON
        }
        // Unlike a standard group — whose top-left label row is a fixed slot
        // that exists named or not — this stack reserves height only for the
        // lines it has (`groupHeaderBandHeight`). A band for an absent title
        // would sit on top of the type line, so a blank-titled wrapper gets no
        // band. Degenerate anyway: the title mirrors the parent object's name,
        // and no edit path can blank an object's name.
        if (hdr.titleText) {
          ctx.fillStyle = this.skin.groups.label
          ctx.font = this.getCanvasFont('600', hdr.titleSize, 'Inter', 'groupTitle')
          ctx.textBaseline = 'top'
          if (!this.isEditingRun('group', group.id, 'title')) {
            ctx.fillText(hdr.titleText, cx, cur)
          }
          painted.title = {
            x: bandX,
            y: cur,
            width: bandWidth,
            height: hdr.titleLineH,
            fontSize: hdr.titleSize,
            lineHeight: hdr.titleLineH,
          }
          cur += hdr.titleLineH
        }
        if (hdr.typeText) {
          cur += HDR_GAP_TYPE
          ctx.fillStyle = this.skin.groups.typeLabel
          ctx.font = this.getCanvasFont('500', HDR_TYPE, 'Inter')
          ctx.textBaseline = 'top'
          ctx.fillText(hdr.typeText, cx, cur)
          cur += hdr.typeLineH
        }
        if (hdr.descText) {
          cur += HDR_GAP_DESC
          ctx.fillStyle = this.skin.groups.description
          ctx.font = this.getCanvasFont('400', hdr.descSize, 'Inter')
          ctx.textBaseline = 'top'
          if (!this.isEditingRun('group', group.id, 'description')) {
            ctx.fillText(hdr.descText, cx, cur)
          }
          painted.description = {
            x: bandX,
            y: cur,
            width: bandWidth,
            height: hdr.descLineH,
            fontSize: hdr.descSize,
            lineHeight: hdr.descLineH,
          }
        }
      }
      this.groupTextBounds.set(group.id, painted)
    } else {
      // Group icon (left of name) and label share ONE vertical centerline
      // (rowCenterY) so the badge and text read as a single aligned row. The icon
      // is center-anchored; the label uses textBaseline 'middle' at the same Y.
      //
      // rowCenterY puts the icon's TOP inset equal to its LEFT inset (both = iconPad),
      // so the badge sits in a balanced top-left corner instead of jammed against the
      // top border (a fixed y+12 would leave only a 2px top gap against a 12px left gap).
      // The row's bottom (y + iconPad + iconSize = y+32) stays inside the reserved
      // header band (GROUP_STD_HEADER_PAD; mirrored as GROUP_STD_PAD_TOP in
      // src/lib/layout/metrics.ts), so members never collide with the header.
      const iconSize = 20
      const iconPad = 12
      const iconGap = 8
      const rowCenterY = y + iconPad + iconSize / 2
      if (group.icon) {
        this.renderTechnologyIcon(ctx, group, x + iconPad + iconSize / 2, rowCenterY)
      }

      // Label
      ctx.globalAlpha = 0.7
      ctx.fillStyle = this.skin.groups.label
      ctx.font = this.getCanvasFont('500', 11, 'Inter', 'groupTitle')
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const labelX = group.icon ? x + iconPad + iconSize + iconGap : x + 12
      if (!this.isEditingRun('group', group.id, 'title')) {
        ctx.fillText(group.name, labelX, rowCenterY)
      }
      // Record what was painted, for the inline editor to sit exactly on top of.
      // Nothing here is fitted or truncated — `measureGroupTitleMinWidth` keeps
      // the box wide enough for the whole name — so the rect is the measurement.
      // An unnamed group still gets a band: otherwise the one group that most
      // needs naming is the one that cannot be double-clicked.
      const labelSize = Math.max(this.themeBridge.fontMinSize ?? 11, 11)
      // Slack past the measured text, for two reasons: the editor's textarea is
      // not laid out by the canvas font, so an exact fit wraps a title that sits
      // on one line here; and a rename usually gets LONGER. Capped at the header
      // row's remaining width so a wide group does not open a wide editor.
      // The floor keeps an unnamed group clickable, but `available` still wins:
      // a band wider than its own group would reach past the box and, now that
      // the hit test walks every group's band rather than one winner, could take
      // a double-click meant for whatever sits beside it.
      const available = Math.max(0, x + w - 12 - labelX)
      const measured = ctx.measureText(group.name ?? '').width
      const labelWidth = Math.min(available, Math.max(60, measured + 24))
      this.groupTextBounds.set(group.id, {
        title: {
          x: labelX,
          y: rowCenterY - labelSize / 2,
          width: labelWidth,
          height: labelSize,
          fontSize: labelSize,
          lineHeight: labelSize * 1.25,
        },
        // A standard group paints no description; only a parent wrapper does.
        description: null,
      })

      // Perspective bottom bar for groups (tags only)
      this.renderGroupBottomBar(ctx, group, groupArgs.geom)
    }

    // Theme HUD decoration on groups (e.g. cyberpunk corner brackets)
    this.themeBridge.runSeamPost('selection', ctx as unknown as Draw, {
      ctx: this.frameRenderContext!,
      target: groupArgs,
    })

    ctx.restore()
  }

  // --- Resize handles ---

  private getResizeHandleScreenSize(): number {
    // Handle size in screen pixels — constant regardless of zoom
    return 6
  }

  private getActiveResizeBounds(): { x: number; y: number; w: number; h: number } | null {
    const selectedObjectIds = this.getSelectedObjectIds()
    const selectedGroupIds = this.selectedItems.filter((s) => s.type === 'group').map((s) => s.id)

    // Multi-select objects: combined bounds
    if (selectedObjectIds.length > 1) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const id of selectedObjectIds) {
        const obj = this.objects.find((o) => o.id === id)
        if (obj) {
          minX = Math.min(minX, obj.position.x)
          minY = Math.min(minY, obj.position.y)
          maxX = Math.max(maxX, obj.position.x + obj.size.width)
          maxY = Math.max(maxY, obj.position.y + obj.size.height)
        }
      }
      if (minX !== Infinity) {
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
      }
    }

    // Single object
    if (selectedObjectIds.length === 1) {
      const obj = this.objects.find((o) => o.id === selectedObjectIds[0])
      if (obj) {
        return { x: obj.position.x, y: obj.position.y, w: obj.size.width, h: obj.size.height }
      }
    }

    // Single group
    if (selectedGroupIds.length === 1 && selectedObjectIds.length === 0) {
      const group = this.groups.find((g) => g.id === selectedGroupIds[0])
      if (group) {
        const bounds = this.getGroupBounds(group)
        if (bounds) return { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
      }
    }

    return null
  }

  private renderResizeHandles(ctx: CanvasRenderingContext2D) {
    if (this.readonly) return
    if (this.toolMode !== 'select') return
    if (this.isAnchorDragging || this.draggingConnEndpoint) return

    const bounds = this.getActiveResizeBounds()
    if (!bounds) return

    const handleSize = this.getResizeHandleScreenSize() / this.viewport.scale
    const hs = handleSize / 2

    const corners: { x: number; y: number; handle: 'nw' | 'ne' | 'sw' | 'se' }[] = [
      { x: bounds.x, y: bounds.y, handle: 'nw' },
      { x: bounds.x + bounds.w, y: bounds.y, handle: 'ne' },
      { x: bounds.x, y: bounds.y + bounds.h, handle: 'sw' },
      { x: bounds.x + bounds.w, y: bounds.y + bounds.h, handle: 'se' },
    ]

    for (const corner of corners) {
      const isHovered = this.hoveredResizeHandle?.handle === corner.handle
      ctx.save()
      ctx.fillStyle = this.skin.resizeHandles.fill
      ctx.strokeStyle = isHovered ? this.skin.resizeHandles.strokeHover : this.skin.resizeHandles.stroke
      ctx.lineWidth = 1.5 / this.viewport.scale
      ctx.beginPath()
      ctx.rect(corner.x - hs, corner.y - hs, handleSize, handleSize)
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
  }

  private getAnchorCorner(bounds: { x: number; y: number; w: number; h: number }, handle: 'nw' | 'ne' | 'sw' | 'se'): { x: number; y: number } {
    switch (handle) {
      case 'nw': return { x: bounds.x + bounds.w, y: bounds.y + bounds.h }
      case 'ne': return { x: bounds.x, y: bounds.y + bounds.h }
      case 'sw': return { x: bounds.x + bounds.w, y: bounds.y }
      case 'se': return { x: bounds.x, y: bounds.y }
    }
  }

  private computeResizeScale(handle: 'nw' | 'ne' | 'sw' | 'se', delta: number, startSize: number, axis: 'x' | 'y'): number {
    const isExpanding = (axis === 'x' && (handle === 'se' || handle === 'ne')) || (axis === 'y' && (handle === 'se' || handle === 'sw'))
    const newSize = isExpanding ? startSize + delta : startSize - delta
    return Math.max(1, newSize) / Math.max(1, startSize)
  }

  private hitTestResizeHandle(x: number, y: number): { handle: 'nw' | 'ne' | 'sw' | 'se'; targetId: string; targetType: 'object' | 'group' } | null {
    if (this.toolMode !== 'select') return null

    const bounds = this.getActiveResizeBounds()
    if (!bounds) return null

    const hitRadius = 10 / this.viewport.scale
    const corners: { x: number; y: number; handle: 'nw' | 'ne' | 'sw' | 'se' }[] = [
      { x: bounds.x, y: bounds.y, handle: 'nw' },
      { x: bounds.x + bounds.w, y: bounds.y, handle: 'ne' },
      { x: bounds.x, y: bounds.y + bounds.h, handle: 'sw' },
      { x: bounds.x + bounds.w, y: bounds.y + bounds.h, handle: 'se' },
    ]

    // Find target id/type for the resize operation
    const selectedObjectIds = this.getSelectedObjectIds()
    let targetId: string | null = null
    let targetType: 'object' | 'group' = 'object'

    if (selectedObjectIds.length >= 1) {
      targetId = selectedObjectIds[0]
      targetType = 'object'
    } else {
      const selectedGroup = this.selectedItems.find((s) => s.type === 'group')
      if (selectedGroup) {
        targetId = selectedGroup.id
        targetType = 'group'
      }
    }

    if (!targetId) return null

    for (const corner of corners) {
      if (Math.hypot(x - corner.x, y - corner.y) <= hitRadius) {
        return { handle: corner.handle, targetId, targetType }
      }
    }
    return null
  }

  private getFlowOpacity(_obj: C4Object): number {
    return 1
  }

  private getFlowConnectionState(conn: Connection): 'hidden' | 'dim' | 'active' | 'normal' {
    if (this.flowEditMode || !this.currentFlowId) return 'normal'
    const flow = this.flows.find((f) => f.id === this.currentFlowId)
    if (!flow || flow.steps.length === 0) return 'normal'
    const currentStep = flow.steps[this.currentFlowStepIndex]
    if (!currentStep) return 'normal'
    if (currentStep.type === 'message' && currentStep.connectionId === conn.id) return 'active'
    return 'normal'
  }

  private getCurrentFlowStepColor(): string | null {
    if (this.flowEditMode || !this.currentFlowId) return null
    const flow = this.flows.find((f) => f.id === this.currentFlowId)
    if (!flow || flow.steps.length === 0) return null
    const step = flow.steps[this.currentFlowStepIndex]
    if (!step) return null
    const colors = this.skin.flow
    return colors[step.type] || null
  }

  private renderFlowStepOverlays(ctx: CanvasRenderingContext2D) {
    if (this.flowEditMode) return
    const flow = this.flows.find((f) => f.id === this.currentFlowId)
    if (!flow) return
    const step = flow.steps[this.currentFlowStepIndex]
    if (!step) return

    if (step.type === 'process') {
      const obj = this.objects.find((o) => o.id === step.objectId)
      if (!obj) return
      const x = obj.position.x + obj.size.width / 2
      const y = obj.position.y - 8
      const text = step.title
      ctx.font = this.getCanvasFont('bold', 12)
      const padding = 8
      const textWidth = ctx.measureText(text).width
      const w = textWidth + padding * 2
      const h = 24

      ctx.save()
      ctx.fillStyle = this.skin.flowBadgeFallback
      ctx.beginPath()
      ctx.roundRect(x - w / 2, y - h, w, h, 6)
      ctx.fill()

      ctx.fillStyle = this.skin.connections.labelBg
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, x, y - h / 2 + 1)
      ctx.restore()
    }

    // Description cards are rendered as React HTML overlays in CanvasView
  }

  private getFittedFontSize(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    baseSize: number,
    minSize: number,
    fontWeight: string,
    role?: 'title' | 'groupTitle'
  ): number {
    const fm = this.themeBridge.fontMinSize
    const floorMin = fm ? Math.max(minSize, fm) : minSize
    for (let size = baseSize; size >= floorMin; size -= 0.5) {
      ctx.font = this.getCanvasFont(fontWeight, size, 'Inter', role)
      if (ctx.measureText(text).width <= maxWidth) return size
    }
    return floorMin
  }

  private truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text
    let truncated = text
    while (truncated.length > 0 && ctx.measureText(truncated + '...').width > maxWidth) {
      truncated = truncated.slice(0, -1)
    }
    return truncated + '...'
  }

  private wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const words = text.split(' ')
    const lines: string[] = []
    let currentLine = ''

    for (const word of words) {
      const testLine = currentLine ? currentLine + ' ' + word : word
      if (ctx.measureText(testLine).width <= maxWidth) {
        currentLine = testLine
      } else {
        if (currentLine) lines.push(currentLine)
        currentLine = word
      }
    }
    if (currentLine) lines.push(currentLine)
    return lines.length > 0 ? lines : [text]
  }

  private getCanvasFont(weight: string, size: number, fallback = 'Inter', role?: 'title' | 'groupTitle'): string {
    const rs = this.skin.renderStyle
    let family: string
    if (role === 'groupTitle' && rs.groupTitleFontFamily) {
      family = rs.groupTitleFontFamily
    } else if (role === 'title' && rs.titleFontFamily) {
      family = rs.titleFontFamily
    } else {
      family = rs.fontFamily || fallback
    }
    const fm = this.themeBridge.fontMinSize
    const minSize = fm ?? size
    return `${weight} ${Math.max(minSize, size)}px ${family}`
  }

  /**
   * At fit-all zoom a 160px card is roughly 40 screen pixels wide. Text,
   * badges, icons, gradients and shadows are not legible there but dominated
   * the measured dense frame. Keep silhouette, semantic state and perspective
   * accent; selected/hovered objects still use the full renderer.
   */
  private renderObjectLowZoom(ctx: CanvasRenderingContext2D, obj: C4Object): void {
    const objectSkin = this.skin.objects[obj.type]
    const isExternal = obj.scope === 'external'
    const isConnectedToHover = this.isObjectConnectedToHovered(obj)
    const isFocusMode = this.isInFocusMode()
    const tagFocusMode = this.activeFocusedPerspectiveId() !== null
    const tagFocusState = tagFocusMode ? this.isObjectInTagFocus(obj) : 'focus'
    let alpha = this.getFlowOpacity(obj)
    if (isFocusMode && !this.isObjectInFocus(obj)) alpha *= 0.15
    if (tagFocusState === 'none') alpha *= 0.15
    else if (tagFocusState === 'connected') alpha *= 0.4
    if (this.objectPerspectiveHiddenState(obj).temporarilyRevealed) alpha *= 0.4

    const x = obj.position.x
    const y = obj.position.y
    const width = obj.size.width
    const height = obj.size.height
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = isExternal ? objectSkin.fillExternal : objectSkin.fill
    ctx.strokeStyle = isConnectedToHover ? objectSkin.strokeConnected : objectSkin.stroke
    ctx.lineWidth = isConnectedToHover ? objectSkin.strokeWidth + 1 : objectSkin.strokeWidth
    if (obj.type === 'component') ctx.setLineDash([4, 4])
    if (obj.type === 'store') {
      buildCylinderPath(ctx, x, y, width, height, storeCapRy(width, height))
    } else {
      buildRoundRectPath(ctx, x, y, width, height, 8)
    }
    ctx.fill()
    ctx.stroke()
    ctx.setLineDash([])
    this.renderObjectBottomBar(ctx, obj, {
      x,
      y,
      w: width,
      h: height,
      cornerRadius: 8,
      cx: x + width / 2,
      cy: y + height / 2,
    })
    ctx.restore()
  }

  /**
   * Fitted text layout of an object card (centring offset, fitted + truncated
   * title, fitted + wrapped description). It depends only on the text, the box
   * size and the font identity — never on position, zoom, hover or selection —
   * yet fitting it takes a measureText per candidate size, per truncated
   * character and per wrapped word, so it is memoized per object and recomputed
   * only when its key changes (−19 to −23 % per frame at zoom 0.6–1, pixel-
   * identical; measured with bench/canvas2d). Computed at the origin:
   * every quantity below is a difference of offsets from the box's own top.
   * `ctx.font` is restored before returning.
   */
  private getObjectTextLayout(
    ctx: CanvasRenderingContext2D,
    obj: C4Object,
    description: string | undefined,
    w: number,
    h: number,
  ): ObjectTextLayout {
    const titleBase = this.skin.renderStyle.titleSize?.base ?? 13
    const titleMin = this.skin.renderStyle.titleSize?.min ?? 9
    const key = `${w}|${h}|${obj.type}|${obj.icon ? 1 : 0}|${this.skin.id}|${titleBase}|${titleMin}|${this.themeBridge.fontMinSize ?? ''}|${obj.name}|${description ?? ''}`
    const cached = this.objectTextLayoutCache.get(obj.id)
    if (cached && cached.key === key) return cached.layout

    const prevFont = ctx.font
    const isStore = obj.type === 'store'
    const storeCap = isStore ? storeCapRy(w, h) : 0
    // Stores: treat icon + title + description + badge as ONE block and vertically
    // centre it in the drum body (lid lip → base), instead of anchoring the icon to
    // the top and the badge to the bottom. `contentTop` shifts icon/title/desc;
    // The type badge is part of the centred block. On content-heavy
    // stores the block fills the body (sits just below the lid); on lighter/taller
    // ones the whole block — icon included — centres in the middle.
    let contentTop: number // set unconditionally in both branches below
    // Store-only: cap how many description lines the drum can show while
    // reserving the icon/title above and localized type badge below.
    let storeDescLineCap = Infinity
    // Base-size (11px) wrap of the description, computed once for the centring
    // estimate and reused by the fit loop's first iteration so the estimate costs
    // no extra measureText work.
    let descBaseWrap: string[] | null = null
    if (isStore) {
      const titleH = titleBase
      const lineH = Math.round(11 * 1.15)
      const topOff = obj.icon ? 12 : 38 // icon top, else title top (offsets from y)
      const usableTop = 2 * storeCap + 3 // a little breathing room under the lid
      const usableH = h - 3 * storeCap - 3 // lid lip+gap → base top
      // Wrap the description at base size to get its true (width-based) line count, then
      // CLAMP it to what the drum can actually show once the icon/title above and the
      // type badge below are reserved. Adding an icon raises topOff (38→12), so a
      // 3-line description that fit icon-less may only have room for 1 line; without this
      // clamp the badge stayed anchored to the full 3-line position and fell outside the
      // drum. descBaseWrap (the full wrap) still feeds the fit loop, which re-fits the font
      // and truncates the visible text; storeDescLineCap caps it to the same count so the
      // render and this estimate agree.
      let descLines = 0
      if (description) {
        ctx.font = this.getCanvasFont('400', 11)
        descBaseWrap = this.wrapText(ctx, description, w - 16)
        const nonDescH = 74 - topOff // block height excluding the always-present type badge
        storeDescLineCap = Math.max(1, Math.floor((usableH - nonDescH) / lineH))
        descLines = Math.min(descBaseWrap.length, storeDescLineCap)
      }
      const descH = descLines * lineH
      const descBottomOff = description ? 54 + descH : 38 + titleH
      const badgeTopOff = descBottomOff + DESCRIPTION_TO_TYPE_BADGE_GAP
      const bottomOff = badgeTopOff + TYPE_BADGE_HEIGHT
      const blockH = bottomOff - topOff
      contentTop = Math.round(usableTop + Math.max(0, (usableH - blockH) / 2) - topOff)
    } else {
      // Non-store: vertically centre the icon + title + description block in the body
      // (mirrors the store path) so content doesn't cluster at the top of a tall box.
      // Engages only when the box has spare room — small boxes keep contentTop = 0 and
      // render exactly as before. blockH uses a base-size line estimate; the
      // description fit below stays correct because it never clips a centred block
      // (availableHeight = bottom-limit − contentTop always leaves room for the block).
      let estDescLines = 0
      if (description) {
        ctx.font = this.getCanvasFont('400', 11)
        descBaseWrap = this.wrapText(ctx, description, w - 16)
        estDescLines = descBaseWrap.length
      }
      const blockTopOff = 12 // icon top at contentTop = 0
      const blockBottomOff = description ? 54 + estDescLines * Math.round(11 * 1.15) : 38 + titleBase
      const blockH = blockBottomOff - blockTopOff
      const topInset = 10
      const bottomReserve = 28 // localized type badge / bottom-bar reserve
      const usableH = h - topInset - bottomReserve
      contentTop = Math.max(0, Math.round((usableH - blockH) / 2) - (blockTopOff - topInset))
    }

    // Title
    const textMaxWidth = w - 16
    const titleSize = this.getFittedFontSize(ctx, obj.name, textMaxWidth, titleBase, titleMin, '600', 'title')
    ctx.font = this.getCanvasFont('600', titleSize, 'Inter', 'title')
    const titleText = this.truncateText(ctx, obj.name, textMaxWidth)

    // Description
    const descBaseSize = 11
    const descMinSize = 9 // readable floor; below this we ellipsize instead of shrinking
    let descSize = descMinSize
    let lines: string[] = []
    if (description) {
      // Measure against the shared badge anchor so both renderers preserve the
      // same gap even when the description shrinks or wraps.
      const anchors = objectContentLayout({ x: 0, y: 0, width: w, height: h, contentTop })
      const availableHeight = Math.max(
        0,
        anchors.typeBadgeTopY - DESCRIPTION_TO_TYPE_BADGE_GAP - anchors.descriptionTopY,
      )

      // Find the largest font size where all wrapped text fits vertically
      for (let size = descBaseSize; size >= descMinSize; size -= 0.5) {
        ctx.font = this.getCanvasFont('400', size)
        // Reuse the base-size wrap from the centring estimate (same text/width/font)
        // on the first iteration so we don't wrap twice; re-wrap only when shrinking.
        const testLines = size === descBaseSize && descBaseWrap
          ? descBaseWrap
          : this.wrapText(ctx, description, textMaxWidth)
        const lineHeight = size * OBJECT_DESC_LINE_HEIGHT_FACTOR
        // storeDescLineCap (Infinity off-store) caps the drum's line budget so the badge
        // anchor below stays inside the cylinder; availableHeight bounds every other type.
        const maxLines = Math.max(1, Math.min(storeDescLineCap, Math.floor(availableHeight / lineHeight)))
        if (testLines.length <= maxLines) {
          descSize = size
          lines = testLines
          break
        }
      }

      // If nothing fit, use min size and truncate to visible lines
      if (lines.length === 0) {
        descSize = descMinSize
        ctx.font = this.getCanvasFont('400', descSize)
        lines = this.wrapText(ctx, description, textMaxWidth)
        const lineHeight = descSize * OBJECT_DESC_LINE_HEIGHT_FACTOR
        const maxLines = Math.max(1, Math.min(storeDescLineCap, Math.floor(availableHeight / lineHeight)))
        const visibleLines = lines.slice(0, maxLines)
        if (visibleLines.length > 0) {
          let lastLine = visibleLines[visibleLines.length - 1]
          while (lastLine.length > 0 && ctx.measureText(lastLine + '...').width > textMaxWidth) {
            lastLine = lastLine.slice(0, -1)
          }
          visibleLines[visibleLines.length - 1] = lastLine + '...'
        }
        lines = visibleLines
      }
    }
    ctx.font = prevFont

    const layout: ObjectTextLayout = { contentTop, titleSize, titleText, descSize, descLines: lines }
    this.objectTextLayoutCache.set(obj.id, { key, layout })
    return layout
  }

  private renderObject(ctx: CanvasRenderingContext2D, obj: C4Object) {
    const description = objectShortDescription(obj)
    const fastMode = this.isInteracting
    const isSelected = this.isObjectSelected(obj.id)
    const isHovered = this.hoveredId === obj.id
    if (this.usesLowZoomLod() && !isSelected && !isHovered) {
      this.renderObjectLowZoom(ctx, obj)
      return
    }
    const isExternal = obj.scope === 'external'
    const flowOpacity = this.getFlowOpacity(obj)
    const isConnectedToHover = this.isObjectConnectedToHovered(obj)
    const isInFocus = this.isObjectInFocus(obj)
    const isFocusMode = this.isInFocusMode()
    const tagFocusState = this.isObjectInTagFocus(obj)
    const isTagFocusMode = this.activeFocusedPerspectiveId() !== null
    const hoveredTag = this.getObjectHoveredTag(obj)
    const pinnedPresentation = resolvePinnedTagPresentation(obj, this.tags, this.pinnedTagIds)
    const managedKind = this.activeManagedPerspective()
    const managedInteraction = managedKind ? this.managedPerspectiveInteractions[managedKind] : null
    const hoveredFacet = managedKind && managedInteraction?.hoveredId
      ? objectFacetValues(obj, managedKind).find((value) => value.id === managedInteraction.hoveredId) ?? null
      : null
    const facetPinned = managedKind && managedInteraction
      ? resolvePinnedFacetPresentation(obj, managedKind, managedInteraction.pinnedIds)
      : null
    const facetColor = (value: { id: string; label: string }) => managedKind === 'technology'
      ? resolveTechnologyColor(value.label, this.skin)
      : managedKind === 'status'
        ? resolveStatusColor(value.id as C4Object['status'], this.skin)
        : resolveTeamColor(value.id)
    const hoveredPerspectiveColor = hoveredTag?.color ?? (hoveredFacet ? facetColor(hoveredFacet) : null)
    const hiddenTagState = this.objectPerspectiveHiddenState(obj)

    let x = obj.position.x
    let y = obj.position.y
    let w = obj.size.width
    let h = obj.size.height
    const pixelSnap = this.themeBridge.pixelSnap
    if (pixelSnap) {
      x = Math.round(x / pixelSnap) * pixelSnap
      y = Math.round(y / pixelSnap) * pixelSnap
      w = Math.round(w / pixelSnap) * pixelSnap
      h = Math.round(h / pixelSnap) * pixelSnap
    }
    const r = 8

    ctx.save()
    let alpha = flowOpacity
    if (isFocusMode && !isInFocus) {
      alpha *= 0.15
    }
    if (isTagFocusMode) {
      if (tagFocusState === 'none') {
        alpha *= 0.15
      } else if (tagFocusState === 'connected') {
        alpha *= 0.4
      }
    }
    if (hiddenTagState.temporarilyRevealed) {
      // A hidden-Tag hover reveals only matching objects, deliberately dimmed.
      alpha *= 0.4
    }
    ctx.globalAlpha = alpha

    // Theme glitch offset (e.g. cyberpunk) — only on selected shape, skipped in fast mode
    const glitchX = this.frameAnim.glitchX ?? 0
    const glitchY = this.frameAnim.glitchY ?? 0
    if (!fastMode && isSelected && (glitchX !== 0 || glitchY !== 0)) {
      ctx.translate(glitchX, glitchY)
    }

    // Hover highlight glow — skipped in fast mode
    if (!fastMode && hoveredPerspectiveColor) {
      ctx.shadowColor = hoveredPerspectiveColor + '80'
      ctx.shadowBlur = 16
      ctx.shadowOffsetY = 0
      ctx.shadowOffsetX = 0
    }

    const objSkin = this.skin.objects[obj.type]
    // Neon glow pulse factor (theme-supplied value, else data-driven sine, else 1)
    const neonGlow = this.skin.renderStyle.neonGlow
    const glowPulse = neonGlow?.enabled
      ? (this.frameAnim.glowPulse ?? 1 + Math.sin(Date.now() / neonGlow.pulseSpeed) * 0.25 * neonGlow.intensity)
      : 1

    // Shadow - very subtle (skip when hover highlight is active or fast mode)
    if (!fastMode && !hoveredPerspectiveColor) {
      if (!isExternal) {
        ctx.shadowColor = objSkin.shadowColor
        ctx.shadowBlur = (isHovered ? objSkin.shadowBlurHover : objSkin.shadowBlur) * (isSelected ? glowPulse : 1)
        ctx.shadowOffsetY = isHovered ? objSkin.shadowOffsetYHover : objSkin.shadowOffsetY
        ctx.shadowOffsetX = 0
      } else {
        ctx.shadowColor = objSkin.shadowColorExternal
        ctx.shadowBlur = 3 * (isSelected ? glowPulse : 1)
        ctx.shadowOffsetY = 1
        ctx.shadowOffsetX = 0
      }
    }

    // Background
    let bgColor = objSkin.fill
    if (isExternal) {
      bgColor = objSkin.fillExternal
    } else if (obj.type === 'store') {
      bgColor = objSkin.fill
    }
    
    const gradient = ctx.createLinearGradient(x, y, x, y + h)
    gradient.addColorStop(0, bgColor)
    gradient.addColorStop(1, bgColor)
    ctx.fillStyle = gradient

    // Border
    if (isSelected) {
      ctx.strokeStyle = objSkin.strokeSelected
      ctx.lineWidth = objSkin.strokeWidth + 1
      ctx.shadowColor = this.skin.selection.glow
      ctx.shadowBlur = this.skin.selection.shadowBlur * (isSelected ? glowPulse : 1)
      ctx.shadowOffsetY = 0
      ctx.shadowOffsetX = 0
    } else if (isHovered) {
      ctx.strokeStyle = objSkin.strokeHover
      ctx.lineWidth = objSkin.strokeWidth + 0.5
    } else if (isConnectedToHover) {
      ctx.strokeStyle = objSkin.strokeConnected
      ctx.lineWidth = objSkin.strokeWidth + 1
    } else if (obj.type === 'component') {
      ctx.strokeStyle = objSkin.stroke
      ctx.lineWidth = objSkin.strokeWidth
      ctx.setLineDash([4, 4])
    } else if (obj.type === 'store') {
      ctx.strokeStyle = objSkin.stroke
      ctx.lineWidth = objSkin.strokeWidth
    } else {
      ctx.strokeStyle = objSkin.stroke
      ctx.lineWidth = objSkin.strokeWidth
    }

    // Rounded rect — themes that pixel-snap force sharp corners (was: eightbit)
    const cornerR = pixelSnap ? 0 : objSkin.cornerRadius

    // Stores render as a database cylinder. `storeCap` is the elliptical cap depth;
    // `contentTop` shifts body content (icon/title/desc/indicators) down below the
    // top lid so nothing overlaps the curved caps. Zero for every other type.
    const isStore = obj.type === 'store'
    const storeCap = isStore ? storeCapRy(w, h) : 0
    const textLayout = this.getObjectTextLayout(ctx, obj, description, w, h)
    const contentLayout = objectContentLayout({ x, y, width: w, height: h, contentTop: textLayout.contentTop })

    // Object box seam — the active theme's `object` replace hook owns the box
    // (pixel-art / cyberpunk grunge / graffiti double / etc.); the default path
    // draws a plain rounded rect. Shared content (icon/text/badges) follows below
    // regardless. Colors, shadow and glow were resolved above and are read by the
    // hook via the args / the live ctx state.
    const objectArgs: ObjectArgs = {
      ctx: this.frameRenderContext!,
      id: obj.id,
      type: obj.type,
      name: obj.name,
      geom: { x, y, w, h, cornerRadius: cornerR, cx: x + w / 2, cy: y + h / 2 },
      state: {
        selected: isSelected,
        hovered: isHovered,
        connectedToHover: isConnectedToHover,
        focused: isInFocus,
        external: isExternal,
        alpha,
      },
      fill: bgColor,
      stroke: ctx.strokeStyle as string,
      strokeWidth: ctx.lineWidth,
    }
    if (!this.themeBridge.runSeam('object', ctx as unknown as Draw, objectArgs)) {
      if (isStore) {
        // Database cylinder body (fill + state stroke cast the shadow/glow), then
        // the 3-D lid: a light disc highlight + the front-rim seam line.
        buildCylinderPath(ctx, x, y, w, h, storeCap)
        ctx.fillStyle = gradient
        ctx.fill()
        ctx.stroke()
        ctx.shadowColor = 'transparent'
        ctx.strokeStyle = isExternal ? objSkin.cylinderLineExternal : objSkin.cylinderLine
        ctx.lineWidth = 1
        // Lid highlight derived from the store fill (not hardcoded white) so it
        // reads as a lit top in light mode yet stays a subdued dark-grey in dark
        // mode — distinct from the near-black body without reading as a white cap.
        strokeStoreLid(ctx, x, y, w, storeCap, isExternal ? undefined : lightenHex(objSkin.fill, 0.25))
      } else {
        buildRoundRectPath(ctx, x, y, w, h, cornerR)
        ctx.fillStyle = gradient
        ctx.fill()
        ctx.stroke()
      }
    }
    ctx.setLineDash([])
    ctx.shadowColor = 'transparent'

    // External indicator - more visibly distinct. Themes can opt out of the alpha
    // fade (design-system treatment): external then reads back via its quieter
    // `*External` colours alone, as a solid calmer card rather than a faded one.
    if (isExternal && !this.skin.renderStyle.solidExternal) {
      ctx.globalAlpha = 0.55
    }

    // Icon
    const iconY = contentLayout.iconCenterY
    if (obj.icon) {
      this.renderTechnologyIcon(ctx, obj, contentLayout.centerX, iconY)
    } else {
      const iconColor = isExternal ? objSkin.iconExternal : objSkin.icon

      if (obj.type === 'store') {
        // No inner glyph — the database cylinder silhouette is the icon.
      } else if (obj.type === 'actor') {
        // Person silhouette
        ctx.fillStyle = iconColor
        ctx.beginPath()
        ctx.arc(contentLayout.centerX, iconY - 4, 5, 0, Math.PI * 2)
        ctx.fill()
        ctx.beginPath()
        ctx.arc(contentLayout.centerX, iconY + 6, 8, Math.PI, 0)
        ctx.fill()
      } else {
        // Standard circle with icon
        ctx.fillStyle = iconColor
        ctx.beginPath()
        ctx.arc(contentLayout.centerX, iconY, 10, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = this.skin.connections.labelBg
        ctx.font = this.getCanvasFont('bold', 10)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const iconLetters: Record<string, string> = {
          system: 'S',
          app: 'A',
          component: 'C',
        }
        ctx.fillText(iconLetters[obj.type] || '?', contentLayout.centerX, iconY)
      }
    }

    // Title
    const textMaxWidth = w - 16
    ctx.fillStyle = isExternal ? objSkin.textExternal : objSkin.text
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const titleSize = textLayout.titleSize
    ctx.font = this.getCanvasFont('600', titleSize, 'Inter', 'title')
    const titleText = textLayout.titleText

    if (this.skin.renderStyle.titleShadow?.enabled) {
      const ts = this.skin.renderStyle.titleShadow
      for (const shadow of ts.shadows) {
        ctx.save()
        ctx.fillStyle = shadow.color
        ctx.globalAlpha = shadow.alpha ?? 1
        ctx.fillText(titleText, contentLayout.centerX + shadow.offsetX, contentLayout.titleTopY + shadow.offsetY)
        ctx.restore()
      }
      ctx.fillStyle = isExternal ? objSkin.textExternal : objSkin.text
    }
    // The DRAWN height, not `titleSize`: `getCanvasFont` raises the size to the
    // theme's `fontMinSize` floor (eightbit sets 8), so the two differ.
    const titleDrawnPx = Math.max(this.themeBridge.fontMinSize ?? titleSize, titleSize)
    const editingTitle = this.isEditingRun('object', obj.id, 'title')
    if (!editingTitle) ctx.fillText(titleText, contentLayout.centerX, contentLayout.titleTopY)
    // Record what was painted, for the inline editor to sit exactly on top of.
    const paintedText: ObjectTextBounds = {
      title: {
        x: x + 8,
        y: contentLayout.titleTopY,
        width: textMaxWidth,
        height: titleDrawnPx,
        fontSize: titleDrawnPx,
        lineHeight: titleDrawnPx,
      },
      description: null,
    }
    this.objectTextBounds.set(obj.id, paintedText)

    // Description
    if (description) {
      ctx.fillStyle = isExternal ? objSkin.descriptionExternal : objSkin.description
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'

      const descSize = textLayout.descSize
      const lines = textLayout.descLines
      ctx.font = this.getCanvasFont('400', descSize)
      const lineHeight = descSize * OBJECT_DESC_LINE_HEIGHT_FACTOR
      const descDrawnPx = Math.max(this.themeBridge.fontMinSize ?? descSize, descSize)
      const editingDescription = this.isEditingRun('object', obj.id, 'description')
      if (!editingDescription) {
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], contentLayout.centerX, contentLayout.descriptionTopY + i * lineHeight)
        }
      }
      paintedText.description = {
        x: x + 8,
        y: contentLayout.descriptionTopY,
        width: textMaxWidth,
        height: Math.max(lines.length, 1) * lineHeight,
        fontSize: descDrawnPx,
        lineHeight,
      }
    } else {
      // No description is painted, but the slot where one WOULD go is still a
      // valid target: adding a description is the commonest reason to
      // double-click there, and without this the band resolves to the title and
      // a description can only ever be added from the sidebar.
      const emptySize = Math.max(this.themeBridge.fontMinSize ?? 11, 11)
      paintedText.description = {
        x: x + 8,
        y: contentLayout.descriptionTopY,
        width: textMaxWidth,
        height: emptySize * 1.15,
        fontSize: emptySize,
        lineHeight: emptySize * 1.15,
      }
    }

    // Localized shape-type badge. Technology remains represented by the icon
    // and perspective bars instead of competing with the identity stack.
    const badgeText = objectTypeBadgeLabel(obj.type)
    ctx.font = this.getCanvasFont('500', 9)
    const textWidth = ctx.measureText(badgeText).width
    const badgeW = Math.min(w - 16, textWidth + 12)
    const badgeH = TYPE_BADGE_HEIGHT
    const badgeX = x + (w - badgeW) / 2
    const badgeY = contentLayout.typeBadgeTopY

    ctx.fillStyle = objSkin.badgeBg
    ctx.beginPath()
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4)
    ctx.fill()

    ctx.fillStyle = objSkin.badgeText
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(badgeText, contentLayout.centerX, badgeY + badgeH / 2)

    // Links indicator (top-left corner)
    if (obj.links && obj.links.length > 0) {
      const linkCount = obj.links.length
      const isLinkHovered = this.hoveredLinkId === obj.id
      const linkColor = isLinkHovered ? this.skin.connections.highlight : objSkin.iconExternal

      ctx.font = this.getCanvasFont('500', 9)
      ctx.textBaseline = 'middle'

      const countText = String(linkCount)
      const countW = ctx.measureText(countText).width
      const iconSlotW = 12
      const gap = 4

      const anchorLeft = x + 4
      // Stores: pin the top-corner indicators just below the lid (see storeIndicatorCY)
      // — a fixed, clickable corner spot independent of the centred content block.
      const indicatorY = isStore ? y + 2 * storeCap + 4 : y + 10
      let drawX = anchorLeft

      ctx.textAlign = 'left'

      // Draw link icon
      this.renderLinkIcon(ctx, drawX + iconSlotW / 2, indicatorY, 10, linkColor)
      drawX += iconSlotW + gap

      // Draw count
      ctx.fillStyle = linkColor
      ctx.fillText(countText, drawX, indicatorY)
      drawX += countW + gap

      // Draw "Voir" on hover
      if (isLinkHovered) {
        ctx.fillStyle = this.skin.connections.highlight
        ctx.fillText(i18n.t('canvasEngine.view'), drawX, indicatorY)
      }
    }

    // Associated-diagram affordance (top-right corner). Existing associations
    // stay visible; the create affordance only appears on shape hover in edit mode.
    if (obj.type !== 'actor') {
      const isExpandHovered = this.hoveredExpandId === obj.id
      const expandColor = isExpandHovered
        ? this.skin.connections.highlight
        : (isExternal ? objSkin.iconExternal : objSkin.icon)
      // Cylinder: pin the expand bracket in the top-right corner below the lid
      // (matches storeIndicatorCY / the click hit-area).
      const indicatorY = isStore ? y + 2 * storeCap + 4 : y + 10
      const anchorRight = x + w - 4
      if (this.relatedDiagramObjectIds.has(obj.id)) {
        this.renderExpandIcon(ctx, anchorRight - 10, indicatorY, 10, expandColor)
      } else if (!this.readonly && this.hoveredId === obj.id) {
        this.renderPlusIcon(ctx, anchorRight - 10, indicatorY, 10, expandColor)
      }
    }

    // Perspective bottom bar (tags / technology / status)
    this.renderObjectBottomBar(ctx, obj, objectArgs.geom)

    // Latest matching pin owns the outline. Labels remain in functional Tag
    // assignment order so pinning never reshuffles object metadata.
    const outline = managedKind ? facetPinned?.outline ?? null : pinnedPresentation.outline
    if (outline) {
      const outlineColor = managedKind
        ? facetColor(facetPinned!.outline!)
        : pinnedPresentation.outline!.color
      ctx.save()
      ctx.globalAlpha = 1
      ctx.strokeStyle = outlineColor
      ctx.lineWidth = 1.5
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.roundRect(x - 1, y - 1, w + 2, h + 2, r + 1)
      ctx.stroke()
      ctx.setLineDash([])

      const perspectiveOverflow = managedKind ? facetPinned?.overflowCount ?? 0 : pinnedPresentation.overflowCount
      const labelTexts = managedKind
        ? (facetPinned?.labels ?? []).map((value) => value.label)
        : pinnedPresentation.labels.map((value) => value.value)
      const labelColors = managedKind
        ? (facetPinned?.labels ?? []).map((value) => facetColor(value))
        : pinnedPresentation.labels.map((value) => value.color)
      if (perspectiveOverflow > 0) labelTexts.push(`+${perspectiveOverflow}`)
      ctx.font = this.getCanvasFont('500', 9)
      const labelH = 16
      const labelY = y + h - labelH - 6
      let labelX = x + 4
      for (let index = 0; index < labelTexts.length; index += 1) {
        const labelText = labelTexts[index]
        const labelW = ctx.measureText(labelText).width + 8
        if (labelX + labelW > x + w - 4) break
        const labelColor = labelColors[index] ?? outlineColor
        ctx.fillStyle = labelColor + 'E6'
        ctx.beginPath()
        ctx.roundRect(labelX, labelY, labelW, labelH, 4)
        ctx.fill()
        ctx.fillStyle = this.skin.connections.labelBg
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(labelText, labelX + labelW / 2, labelY + labelH / 2 + 0.5)
        labelX += labelW + 4
      }
      ctx.restore()
    }

    ctx.globalAlpha = 1
    ctx.restore()
  }

  // Bar-color semantics live in src/canvas/bottomBarColors.ts, shared verbatim
  // with the 3D board (Scene3D) so both views color the same object the same way.
  private getObjectBottomBarColors(obj: C4Object): string[] {
    return resolveObjectBottomBarColors(
      obj,
      this.tags,
      this.skin,
      this.bottomTab,
      this.activeTagGroupId,
    )
  }

  private loadIconImage(url: string): HTMLImageElement | null {
    const cached = this.iconImageCache.get(url)
    if (cached) return cached
    if (this.iconImageLoading.has(url)) return null

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      this.iconImageCache.set(url, img)
      this.iconImageLoading.delete(url)
      this.scheduleRender()
    }
    img.onerror = () => {
      this.iconImageLoading.delete(url)
    }
    this.iconImageLoading.add(url)
    img.src = url
    return null
  }

  private renderTechnologyIcon(
    ctx: CanvasRenderingContext2D,
    obj: { icon?: string; iconAssignment?: ShapeIconAssignment },
    cx: number,
    cy: number,
  ) {
    const iconName = obj.iconAssignment?.displayName ?? obj.icon ?? ''
    if (!iconName) return
    const config = {
      bg: '#6B665E',
      text: '#FFFFFF',
      abbr: iconName.length <= 2 ? iconName.toUpperCase() : iconName.slice(0, 1).toUpperCase(),
    }

    const size = 20
    const half = size / 2

    // Try to render actual icon image
    const iconUrl = resolveTechnologyIconPath(
      this.resolvedTheme,
      obj.iconAssignment?.iconLightPath,
      obj.iconAssignment?.iconDarkPath,
    )
    if (iconUrl) {
      const img = this.loadIconImage(iconUrl)
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.save()
        ctx.beginPath()
        // Lift image icons 1px: the text's optical centre (cap-height midpoint) sits
        // ~1px above the EM-box middle; and PNG logos often have slight downward bias.
        const icy = cy - 1
        ctx.roundRect(cx - half, icy - half, size, size, 4)
        ctx.clip()
        ctx.drawImage(img, cx - half, icy - half, size, size)
        ctx.restore()
        return
      }
    }

    // Fallback: generated badge
    ctx.fillStyle = config.bg
    ctx.beginPath()
    ctx.roundRect(cx - half, cy - half, size, size, 5)
    ctx.fill()

    ctx.fillStyle = config.text
    ctx.font = this.getCanvasFont('bold', config.abbr.length > 1 ? 8 : 10)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(config.abbr, cx, cy + 0.5)
  }

  /** Center Y of a store's top corner indicators (link/expand): just below the
   *  cylinder lid. Single source of truth shared by rendering and hit-testing so
   *  the visible icon and its click area never drift apart. */
  private storeIndicatorCY(obj: C4Object): number {
    return obj.position.y + 2 * storeCapRy(obj.size.width, obj.size.height) + 4
  }

  private isClickOnLinkIndicator(obj: C4Object, worldX: number, worldY: number): boolean {
    const x = obj.position.x
    const y = obj.position.y
    void obj.size.width
    const cy = obj.type === 'store' ? this.storeIndicatorCY(obj) : y + 10
    // Approximate hit area for the link indicator in the top-left corner
    const hitLeft = x + 2
    const hitRight = x + 46
    const hitTop = cy - 10
    const hitBottom = cy + 10
    return worldX >= hitLeft && worldX <= hitRight && worldY >= hitTop && worldY <= hitBottom
  }

  private isClickOnExpandIndicator(obj: C4Object, worldX: number, worldY: number): boolean {
    if (this.readonly && !this.relatedDiagramObjectIds.has(obj.id)) return false
    const x = obj.position.x
    const y = obj.position.y
    const w = obj.size.width
    const cy = obj.type === 'store' ? this.storeIndicatorCY(obj) : y + 12
    // Hit area for the expand indicator in the top-right corner
    const hitLeft = x + w - 50
    const hitRight = x + w - 2
    const hitTop = cy - 12
    const hitBottom = cy + 12
    return worldX >= hitLeft && worldX <= hitRight && worldY >= hitTop && worldY <= hitBottom
  }

  private isClickOnGroupExpandIndicator(group: Group, worldX: number, worldY: number): boolean {
    if (this.readonly && (!group.parentObjectId || !this.relatedDiagramObjectIds.has(group.parentObjectId))) {
      return false
    }
    const bounds = this.getGroupBounds(group)
    if (!bounds) return false
    // Hit area for the expand indicator at top-right of parent wrapper group
    const hitLeft = bounds.x + bounds.width - 30
    const hitRight = bounds.x + bounds.width - 2
    const hitTop = bounds.y + 2
    const hitBottom = bounds.y + 22
    return worldX >= hitLeft && worldX <= hitRight && worldY >= hitTop && worldY <= hitBottom
  }

  private isClickOnGroupNavigateUp(group: Group, worldX: number, worldY: number): boolean {
    const bounds = this.getGroupBounds(group)
    if (!bounds) return false
    // Hit area for the back/up indicator at top-left of parent wrapper group
    const hitLeft = bounds.x + 2
    const hitRight = bounds.x + 30
    const hitTop = bounds.y + 2
    const hitBottom = bounds.y + 22
    return worldX >= hitLeft && worldX <= hitRight && worldY >= hitTop && worldY <= hitBottom
  }

  private renderLinkIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const scale = size / 24
    ctx.translate(cx - 12 * scale, cy - 12 * scale)
    ctx.scale(scale, scale)

    // lucide "link" icon paths (24x24 viewBox)
    const path1 = new Path2D('M10 13a5 5 0 0 0 7.54 0.54l3 -3a5 5 0 0 0 -7.07 -7.07l-1.72 1.71')
    const path2 = new Path2D('M14 11a5 5 0 0 0 -7.54 -0.54l-3 3a5 5 0 0 0 7.07 7.07l1.71 -1.71')

    ctx.stroke(path1)
    ctx.stroke(path2)

    ctx.restore()
  }

  private renderExpandIcon(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    size: number,
    color: string
  ) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const scale = size / 24
    ctx.translate(cx - 12 * scale, cy - 12 * scale)
    ctx.scale(scale, scale)

    // Exact lucide "expand" paths used by the Model Viewer.
    const paths = [
      'm15 15 6 6',
      'm15 9 6-6',
      'M21 16v5h-5',
      'M21 8V3h-5',
      'M3 16v5h5',
      'm3 21 6-6',
      'M3 8V3h5',
      'M9 9 3 3',
    ]
    for (const path of paths) ctx.stroke(new Path2D(path))

    ctx.restore()
  }

  private renderPlusIcon(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    size: number,
    color: string,
  ) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.lineCap = 'round'

    const scale = size / 24
    ctx.translate(cx - 12 * scale, cy - 12 * scale)
    ctx.scale(scale, scale)

    // Exact lucide "plus" paths (24x24 viewBox).
    ctx.stroke(new Path2D('M5 12h14'))
    ctx.stroke(new Path2D('M12 5v14'))

    ctx.restore()
  }

  private renderBackIcon(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    size: number,
    color: string
  ) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const scale = size / 24
    ctx.translate(cx - 12 * scale, cy - 12 * scale)
    ctx.scale(scale, scale)

    // lucide "chevron-up" / back-up icon path (24x24 viewBox)
    const path = new Path2D('M6 14l6-6 6 6')

    ctx.stroke(path)
    ctx.restore()
  }

  private renderObjectBottomBar(
    ctx: CanvasRenderingContext2D,
    obj: C4Object,
    geom: ObjectArgs['geom'],
  ) {
    if (!this.bottomTab) return

    const colors = this.getObjectBottomBarColors(obj)
    if (colors.length === 0) return

    const bb = this.skin.bottomBar
    const { x, y, w, h, cornerRadius } = geom
    const isStore = obj.type === 'store'
    const r = isStore ? 0 : bb.cornerRadius
    const barHeight = bb.height
    const barTop = y + h - barHeight

    ctx.save()
    ctx.globalAlpha = bb.opacity
    // Use the already-resolved object geometry and its exact outer contour. In
    // particular, Studio nodes use a 14px box radius while the accent's own
    // decorative radius is 8px; without this clip the stripe overhangs the box.
    clipObjectAccentToBox(ctx, { x, y, w, h, cornerRadius, isStore })

    const segmentWidth = w / colors.length

    for (let i = 0; i < colors.length; i++) {
      const segX = x + i * segmentWidth
      const segW = i === colors.length - 1 ? x + w - segX : segmentWidth

      ctx.fillStyle = colors[i]

      if (r === 0) {
        ctx.fillRect(segX, barTop, segW, barHeight)
      } else {
        ctx.beginPath()
        if (colors.length === 1) {
          ctx.roundRect(segX, barTop, segW, barHeight, [0, 0, r, r])
        } else if (i === 0) {
          ctx.roundRect(segX, barTop, segW, barHeight, [0, 0, 0, r])
        } else if (i === colors.length - 1) {
          ctx.roundRect(segX, barTop, segW, barHeight, [0, 0, r, 0])
        } else {
          ctx.rect(segX, barTop, segW, barHeight)
        }
        ctx.fill()
      }
    }

    ctx.restore()
  }

  private renderGroupBottomBar(
    ctx: CanvasRenderingContext2D,
    group: Group,
    geom: GroupArgs['geom'],
  ) {
    if (this.bottomTab !== 'tags') return

    const bb = this.skin.bottomBar
    const groupObjects: C4Object[] = []
    for (const objectId of group.objectIds) {
      const object = this.objectMap.get(objectId)
      if (object) groupObjects.push(object)
    }
    const colors = resolveGroupBottomBarColors(
      groupObjects,
      this.tags,
      this.skin,
      this.bottomTab,
      this.activeTagGroupId,
    )
    if (colors.length === 0) return

    const { x, y, w, h, cornerRadius } = geom
    const r = bb.cornerRadius
    const barHeight = bb.height

    ctx.save()
    ctx.globalAlpha = bb.opacity
    // The group frame and its accent must share the exact same resolved bounds
    // and 12px silhouette. The bar's decorative radius can be smaller, so clip
    // the painted segments to the canonical group outline to prevent overhangs.
    clipGroupAccentToBox(ctx, { x, y, w, h, cornerRadius })

    const segmentWidth = w / colors.length

    for (let i = 0; i < colors.length; i++) {
      const segX = x + i * segmentWidth
      const segW = i === colors.length - 1 ? x + w - segX : segmentWidth

      ctx.fillStyle = colors[i]

      if (r === 0) {
        ctx.fillRect(segX, y + h - barHeight, segW, barHeight)
      } else {
        ctx.beginPath()
        if (colors.length === 1) {
          ctx.roundRect(segX, y + h - barHeight, segW, barHeight, [0, 0, r, r])
        } else if (i === 0) {
          ctx.roundRect(segX, y + h - barHeight, segW, barHeight, [0, 0, 0, r])
        } else if (i === colors.length - 1) {
          ctx.roundRect(segX, y + h - barHeight, segW, barHeight, [0, 0, r, 0])
        } else {
          ctx.rect(segX, y + h - barHeight, segW, barHeight)
        }
        ctx.fill()
      }
    }

    ctx.restore()
  }

  // 12 anchor points per shape (3 per side)
  private anchorDefs: { side: 'top' | 'bottom' | 'left' | 'right'; ratio: number }[] = [
    // Top: 0=left, 1=center, 2=right
    { side: 'top', ratio: 0.2 },
    { side: 'top', ratio: 0.5 },
    { side: 'top', ratio: 0.8 },
    // Right: 3=top, 4=center, 5=bottom
    { side: 'right', ratio: 0.2 },
    { side: 'right', ratio: 0.5 },
    { side: 'right', ratio: 0.8 },
    // Bottom: 6=left, 7=center, 8=right
    { side: 'bottom', ratio: 0.2 },
    { side: 'bottom', ratio: 0.5 },
    { side: 'bottom', ratio: 0.8 },
    // Left: 9=top, 10=center, 11=bottom
    { side: 'left', ratio: 0.2 },
    { side: 'left', ratio: 0.5 },
    { side: 'left', ratio: 0.8 },
  ]

  // Center anchor index for each side
  private centerAnchorIndices = { top: 1, right: 4, bottom: 7, left: 10 }

  // All anchor indices for each side
  private sideAnchorIndices = {
    top: [0, 1, 2],
    right: [3, 4, 5],
    bottom: [6, 7, 8],
    left: [9, 10, 11],
  }

  private getAnchorPoint(
    cx: number,
    cy: number,
    w: number,
    h: number,
    anchorIndex: number
  ): { x: number; y: number; face: 'top' | 'bottom' | 'left' | 'right' } {
    const def = this.anchorDefs[anchorIndex]
    if (!def) return { x: cx, y: cy, face: 'top' }
    const hw = w / 2
    const hh = h / 2
    const left = cx - hw
    const top = cy - hh
    const r = 8

    let x = cx
    let y = cy

    switch (def.side) {
      case 'top': {
        const edgeLen = Math.max(0, w - 2 * r)
        x = left + r + def.ratio * edgeLen
        y = top
        break
      }
      case 'bottom': {
        const edgeLen = Math.max(0, w - 2 * r)
        x = left + r + def.ratio * edgeLen
        y = top + h
        break
      }
      case 'left': {
        const edgeLen = Math.max(0, h - 2 * r)
        x = left
        y = top + r + def.ratio * edgeLen
        break
      }
      case 'right': {
        const edgeLen = Math.max(0, h - 2 * r)
        x = left + w
        y = top + r + def.ratio * edgeLen
        break
      }
    }

    return { x, y, face: def.side }
  }

  private getConnectionEndpoint(id: string, anchorIndex?: number): { cx: number; cy: number; width: number; height: number; face?: 'top' | 'bottom' | 'left' | 'right' } | null {
    const obj = this.objectMap.get(id)
    if (obj) {
      const cx = obj.position.x + obj.size.width / 2
      const cy = obj.position.y + obj.size.height / 2
      if (anchorIndex !== undefined) {
        const pt = this.getAnchorPoint(cx, cy, obj.size.width, obj.size.height, anchorIndex)
        return { cx: pt.x, cy: pt.y, width: obj.size.width, height: obj.size.height, face: pt.face }
      }
      return { cx, cy, width: obj.size.width, height: obj.size.height }
    }
    const group = this.groupMap.get(id)
    if (group) {
      const bounds = this.getGroupBounds(group)
      if (bounds) {
        const cx = bounds.x + bounds.width / 2
        const cy = bounds.y + bounds.height / 2
        if (anchorIndex !== undefined) {
          const pt = this.getAnchorPoint(cx, cy, bounds.width, bounds.height, anchorIndex)
          return { cx: pt.x, cy: pt.y, width: bounds.width, height: bounds.height, face: pt.face }
        }
        return { cx, cy, width: bounds.width, height: bounds.height }
      }
    }
    return null
  }

  /** Effective line shape: the connection's explicit `shape`, else 'curved'. */
  private resolveConnectionShape(conn: Connection): ConnectionShape {
    return conn.shape ?? 'curved'
  }

  /**
   * Cubic-Bézier control points for a connection's two edge points.
   * - Curved → control points pushed out along each face normal.
   * - Straight → control points placed at 1/3 and 2/3 along the chord, so the
   *   cubic collapses to a straight line. Every renderer (and hit-testing) draws
   *   via bezierCurveTo using these points, so this single switch straightens
   *   all skins at once.
   */
  private computeConnectionControlPoints(
    fromEdge: { x: number; y: number; face: 'top' | 'bottom' | 'left' | 'right' },
    toEdge: { x: number; y: number; face: 'top' | 'bottom' | 'left' | 'right' },
    shape: ConnectionShape
  ): { cp1x: number; cp1y: number; cp2x: number; cp2y: number } {
    if (shape === 'straight') {
      const dx = toEdge.x - fromEdge.x
      const dy = toEdge.y - fromEdge.y
      return {
        cp1x: fromEdge.x + dx / 3,
        cp1y: fromEdge.y + dy / 3,
        cp2x: fromEdge.x + (dx * 2) / 3,
        cp2y: fromEdge.y + (dy * 2) / 3,
      }
    }
    const connectionDist = Math.hypot(toEdge.x - fromEdge.x, toEdge.y - fromEdge.y)
    const controlDist = Math.min(Math.max(connectionDist * 0.4, 30), 150)
    const normals = {
      top: { x: 0, y: -1 },
      bottom: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    } as const
    const fromNormal = normals[fromEdge.face]
    const toNormal = normals[toEdge.face]
    return {
      cp1x: fromEdge.x + fromNormal.x * controlDist,
      cp1y: fromEdge.y + fromNormal.y * controlDist,
      cp2x: toEdge.x + toNormal.x * controlDist,
      cp2y: toEdge.y + toNormal.y * controlDist,
    }
  }

  /** Waypoints in effect for a connection (the live drag copy takes precedence). */
  private getEffectiveWaypoints(conn: Connection): Position[] {
    if (this.draggingWaypointConnId === conn.id && this.workingWaypoints) {
      return this.workingWaypoints
    }
    return conn.waypoints ?? []
  }

  /**
   * Build the ordered cubic-Bézier segments for a connection.
   * - No waypoints → a single segment (identical to the legacy single-curve behavior).
   * - Straight + waypoints → one straight cubic per polyline edge.
   * - Curved + waypoints → a smooth Catmull-Rom spline passing through every point.
   */
  private buildConnectionSegments(
    fromEdge: { x: number; y: number; face: 'top' | 'bottom' | 'left' | 'right' },
    toEdge: { x: number; y: number; face: 'top' | 'bottom' | 'left' | 'right' },
    waypoints: Position[],
    shape: ConnectionShape
  ): CubicSeg[] {
    if (waypoints.length === 0) {
      const cp = this.computeConnectionControlPoints(fromEdge, toEdge, shape)
      return [{ x0: fromEdge.x, y0: fromEdge.y, cp1x: cp.cp1x, cp1y: cp.cp1y, cp2x: cp.cp2x, cp2y: cp.cp2y, x1: toEdge.x, y1: toEdge.y }]
    }

    const pts: Position[] = [{ x: fromEdge.x, y: fromEdge.y }, ...waypoints, { x: toEdge.x, y: toEdge.y }]
    const segs: CubicSeg[] = []

    if (shape === 'straight') {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]
        const b = pts[i + 1]
        segs.push({
          x0: a.x, y0: a.y,
          cp1x: a.x + (b.x - a.x) / 3, cp1y: a.y + (b.y - a.y) / 3,
          cp2x: a.x + ((b.x - a.x) * 2) / 3, cp2y: a.y + ((b.y - a.y) * 2) / 3,
          x1: b.x, y1: b.y,
        })
      }
      return segs
    }

    // Uniform Catmull-Rom → cubic Bézier (endpoints duplicated for open spline).
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[i + 2] ?? pts[i + 1]
      segs.push({
        x0: p1.x, y0: p1.y,
        cp1x: p1.x + (p2.x - p0.x) / 6, cp1y: p1.y + (p2.y - p0.y) / 6,
        cp2x: p2.x - (p3.x - p1.x) / 6, cp2y: p2.y - (p3.y - p1.y) / 6,
        x1: p2.x, y1: p2.y,
      })
    }
    return segs
  }

  /** Trace the full connection path onto ctx (beginPath + moveTo + bezierCurveTo per segment). */
  private traceConnectionPath(ctx: CanvasRenderingContext2D, geom: ConnectionGeometry, offsetX = 0, offsetY = 0) {
    const segs = geom.segments
    ctx.beginPath()
    ctx.moveTo(segs[0].x0 + offsetX, segs[0].y0 + offsetY)
    for (const s of segs) {
      ctx.bezierCurveTo(s.cp1x + offsetX, s.cp1y + offsetY, s.cp2x + offsetX, s.cp2y + offsetY, s.x1 + offsetX, s.y1 + offsetY)
    }
  }

  /** Point at global parameter t∈[0,1] along the whole path (segments weighted equally). */
  private getPathPoint(geom: ConnectionGeometry, t: number): { x: number; y: number } {
    const segs = geom.segments
    const n = segs.length
    const scaled = Math.max(0, Math.min(1, t)) * n
    const i = Math.min(n - 1, Math.floor(scaled))
    const lt = scaled - i
    const s = segs[i]
    return this.getBezierPoint(lt, s.x0, s.y0, s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.x1, s.y1)
  }

  /** Unit tangent at global parameter t∈[0,1] along the whole path. */
  private getPathTangent(geom: ConnectionGeometry, t: number): { x: number; y: number } {
    const segs = geom.segments
    const n = segs.length
    const scaled = Math.max(0, Math.min(1, t)) * n
    const i = Math.min(n - 1, Math.floor(scaled))
    const lt = scaled - i
    const s = segs[i]
    return this.getBezierTangent(lt, s.x0, s.y0, s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.x1, s.y1)
  }

  /** Nearest global t∈[0,1] on the whole path to a point (for label projection). */
  private findNearestTOnPath(geom: ConnectionGeometry, px: number, py: number): number {
    const segs = geom.segments
    const n = segs.length
    const stepsPer = 40
    let bestT = 0.5
    let bestDist = Infinity
    for (let i = 0; i < n; i++) {
      const s = segs[i]
      for (let j = 0; j <= stepsPer; j++) {
        const lt = j / stepsPer
        const pt = this.getBezierPoint(lt, s.x0, s.y0, s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.x1, s.y1)
        const d = (pt.x - px) ** 2 + (pt.y - py) ** 2
        if (d < bestDist) {
          bestDist = d
          bestT = (i + lt) / n
        }
      }
    }
    return bestT
  }

  /** Shortest distance from a point to the whole path. */
  private pathPointDistance(geom: ConnectionGeometry, px: number, py: number): number {
    let min = Infinity
    for (const s of geom.segments) {
      const d = this.bezierPointDistance(px, py, s.x0, s.y0, s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.x1, s.y1)
      if (d < min) min = d
    }
    return min
  }

  /** Index of the segment closest to a point (= insertion index into the waypoints array). */
  private findSegmentIndexAt(geom: ConnectionGeometry, px: number, py: number): number {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < geom.segments.length; i++) {
      const s = geom.segments[i]
      const d = this.bezierPointDistance(px, py, s.x0, s.y0, s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.x1, s.y1)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    return bestIdx
  }

  private refreshConnectionGeometryState(
    conn: Connection,
    geom: ConnectionGeometry,
    flowState: ConnectionGeometry['flowState'],
  ): ConnectionGeometry {
    const isHovered = this.hoveredConnectionId === conn.id
    const isHighlighted = this.isConnectionHighlighted(conn)
    const isFocusMode = this.isInFocusMode()
    const isFocused = isFocusMode && isHighlighted
    let alpha = flowState === 'dim' ? 0.3 : 1
    if (isFocusMode && !isFocused) alpha *= 0.15
    geom.flowState = flowState
    geom.isHovered = isHovered
    geom.isHighlighted = isHighlighted
    geom.isFocused = isFocused
    geom.alpha = alpha
    return geom
  }

  private getConnectionGeometry(conn: Connection): ConnectionGeometry | null {
    const fromObj = this.objectMap.get(conn.fromId)
    const toObj = this.objectMap.get(conn.toId)
    if ((fromObj && this.isObjectHidden(fromObj)) || (toObj && this.isObjectHidden(toObj))) {
      return null
    }
    const focusedPerspectiveId = this.activeFocusedPerspectiveId()
    const managedPerspective = this.activeManagedPerspective()
    const connectionMatchesFocus = Boolean(
      focusedPerspectiveId
      && (managedPerspective
        ? facetValues(conn, managedPerspective).some((value) => value.id === focusedPerspectiveId)
        : conn.tagAssignments?.[focusedPerspectiveId]),
    )
    if (focusedPerspectiveId && this.tagFocusResolved
      && !connectionMatchesFocus
      && !this.tagFocusSet.has(conn.fromId) && !this.tagFocusSet.has(conn.toId)) {
      // Focus keeps only connections incident to a matching object. The
      // opposite endpoint remains as the one-hop, dimmed neighbour.
      return null
    }

    const from = this.getConnectionEndpoint(conn.fromId, conn.lockedToAnchors ? conn.fromAnchor : undefined)
    const to = this.getConnectionEndpoint(conn.toId, conn.lockedToAnchors ? conn.toAnchor : undefined)
    if (!from || !to) return null

    const flowState = this.getFlowConnectionState(conn)
    if (flowState === 'hidden') return null

    // Endpoints, control points and bounds are stable across hover, selection,
    // animation time and perspective colour changes. Keep them until setData or
    // a targeted endpoint placement invalidates this connection; refresh only
    // the cheap per-frame visual state.
    const cached = this.connectionGeometryCache.get(conn.id)
    if (cached) return this.refreshConnectionGeometryState(conn, cached, flowState)

    let fromEdge: { x: number; y: number; face: 'top' | 'bottom' | 'left' | 'right' }
    let toEdge: { x: number; y: number; face: 'top' | 'bottom' | 'left' | 'right' }
    if (conn.lockedToAnchors && conn.fromAnchor !== undefined && from.face) {
      fromEdge = { x: from.cx, y: from.cy, face: from.face }
    } else {
      fromEdge = this.getEdgePoint(from.cx, from.cy, to.cx, to.cy, from.width, from.height)
    }
    if (conn.lockedToAnchors && conn.toAnchor !== undefined && to.face) {
      toEdge = { x: to.cx, y: to.cy, face: to.face }
    } else {
      toEdge = this.getEdgePoint(to.cx, to.cy, from.cx, from.cy, to.width, to.height)
    }

    const segments = this.buildConnectionSegments(
      fromEdge,
      toEdge,
      this.getEffectiveWaypoints(conn),
      this.resolveConnectionShape(conn)
    )
    const first = segments[0]
    const last = segments[segments.length - 1]

    // Legacy single-Bézier fields = first/last segment control points.
    const cp1x = first.cp1x
    const cp1y = first.cp1y
    const cp2x = last.cp2x
    const cp2y = last.cp2y

    const arrowSize = 14
    const fromAngle = Math.atan2(first.y0 - first.cp1y, first.x0 - first.cp1x)
    const toAngle = Math.atan2(last.y1 - last.cp2y, last.x1 - last.cp2x)
    const fromLineX = fromEdge.x - 4 * Math.cos(fromAngle)
    const fromLineY = fromEdge.y - 4 * Math.sin(fromAngle)
    const toLineX = toEdge.x - arrowSize * Math.cos(toAngle)
    const toLineY = toEdge.y - arrowSize * Math.sin(toAngle)

    // Trim the drawn path ends so the source dot / arrowhead have room.
    first.x0 = fromLineX
    first.y0 = fromLineY
    last.x1 = toLineX
    last.y1 = toLineY

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const s of segments) {
      minX = Math.min(minX, s.x0, s.cp1x, s.cp2x, s.x1)
      minY = Math.min(minY, s.y0, s.cp1y, s.cp2y, s.y1)
      maxX = Math.max(maxX, s.x0, s.cp1x, s.cp2x, s.x1)
      maxY = Math.max(maxY, s.y0, s.cp1y, s.cp2y, s.y1)
    }

    const geom: ConnectionGeometry = {
      from,
      to,
      fromEdge,
      toEdge,
      segments,
      cp1x,
      cp1y,
      cp2x,
      cp2y,
      fromLineX,
      fromLineY,
      toLineX,
      toLineY,
      bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      isHidden: false,
      flowState,
      isHovered: false,
      isHighlighted: false,
      isFocused: false,
      alpha: 1,
    }

    this.connectionGeometryCache.set(conn.id, geom)
    return this.refreshConnectionGeometryState(conn, geom, flowState)
  }

  private renderConnection(ctx: CanvasRenderingContext2D, conn: Connection) {
    // A community overlay owning the connection seam draws connections itself.
    if (this.themeBridge.ownsOverlay('connectionLine')) return
    const geom = this.getConnectionGeometry(conn)
    if (!geom) return

    const toEdge = geom.toEdge
    const flowState = geom.flowState
    const isHovered = geom.isHovered
    const isHighlighted = geom.isHighlighted
    const alpha = geom.alpha

    ctx.save()
    ctx.globalAlpha = alpha

    const perspectiveTag = this.bottomTab === 'tags'
      ? resolveConnectionPerspectiveTag(
        this.objectMap.get(conn.fromId),
        this.objectMap.get(conn.toId),
        this.tags,
        this.activeTagGroupId,
        {
          hoveredTagId: this.hoveredTagId,
          focusedTagId: this.focusedTagId,
          pinnedTagIds: this.pinnedTagIds,
        },
        conn,
      )
      : null
    const managedKind = this.activeManagedPerspective()
    const managedInteraction = managedKind ? this.managedPerspectiveInteractions[managedKind] : null
    const perspectiveFacet = managedKind && managedInteraction
      ? resolveConnectionPerspectiveFacet(
        this.objectMap.get(conn.fromId),
        this.objectMap.get(conn.toId),
        managedKind,
        managedInteraction,
        conn,
      )
      : null
    const perspectiveColor = perspectiveTag
      ? resolveTagColor(perspectiveTag.tagId, this.tags, this.skin)
      : perspectiveFacet && managedKind === 'technology'
        ? resolveTechnologyColor(perspectiveFacet.label, this.skin)
        : perspectiveFacet && managedKind === 'status'
          ? resolveStatusColor(perspectiveFacet.id as C4Object['status'], this.skin)
          : perspectiveFacet && managedKind === 'teams'
            ? resolveTeamColor(perspectiveFacet.id)
            : null
    const baseColor = perspectiveColor
      ?? (conn.kind === 'lower' ? this.skin.connections.lower : this.skin.connections.normal)
    const flowActiveColor = flowState === 'active' ? (this.getCurrentFlowStepColor() || this.skin.flowBadgeFallback) : baseColor
    ctx.strokeStyle = isHighlighted ? this.skin.connections.highlight : (isHovered ? this.skin.connections.hover : flowActiveColor)
    ctx.lineWidth = isHighlighted ? this.skin.connections.strokeWidthHighlight : flowState === 'active' ? this.skin.connections.strokeWidthActive : this.skin.connections.strokeWidth
    if (conn.type === 'dashed') {
      ctx.setLineDash([6, 4])
    } else if (conn.type === 'dotted') {
      ctx.setLineDash([2, 3])
    }

    if (this.usesLowZoomLod() && !isHighlighted && !isHovered) {
      this.traceConnectionPath(ctx, geom)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
      return
    }

    const isEightBit = this.themeBridge.pixelSnap != null

    if (isEightBit) {
      const ps = this.themeBridge.pixelSnap ?? 2

      // Draw pixelated Bézier curve (one pass per segment)
      ctx.fillStyle = ctx.strokeStyle as string
      for (const s of geom.segments) {
        this.drawPixelatedBezier(ctx, s.x0, s.y0, s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.x1, s.y1, ps)
      }

      // Pixelated arrowhead — use last segment direction for proper pointing
      const preTip = this.getPathPoint(geom, 0.95)
      this.renderPixelArrowhead(ctx, toEdge.x, toEdge.y, preTip.x, preTip.y, ctx.strokeStyle as string, ps)

      // Label — use path point for positioning with sharp rectangle
      if (conn.label) {
        const isDraggingThisLabel = this.isDraggingLabel && this.draggingLabelConnId === conn.id
        const t = isDraggingThisLabel ? this.dragLabelCurrentT : (conn.labelPosition ?? 0.5)
        const offset = isDraggingThisLabel ? this.dragLabelCurrentOffset : Math.max(-40, Math.min(40, conn.labelOffset ?? 12))
        const labelPt = this.getPathPoint(geom, t)
        const tangent = this.getPathTangent(geom, t)
        const normalX = -tangent.y
        const normalY = tangent.x
        const labelCX = labelPt.x + normalX * offset
        const labelCY = labelPt.y + normalY * offset

        const lines = conn.label.split('\n')
        const lineHeight = 12
        const paddingX = 8
        const paddingY = 4

        ctx.font = this.getCanvasFont('400', 10)
        let maxTextWidth = 0
        for (const line of lines) {
          const w = ctx.measureText(line).width
          if (w > maxTextWidth) maxTextWidth = w
        }

        const labelW = maxTextWidth + paddingX * 2 + ps * 4
        const labelH = lines.length * lineHeight + paddingY * 2
        const labelX = labelCX - labelW / 2
        const labelY = labelCY - labelH / 2

        ctx.fillStyle = this.skin.connections.labelBg
        ctx.strokeStyle = this.skin.connections.labelStroke
        ctx.lineWidth = 1
        ctx.fillRect(labelX, labelY, labelW, labelH)
        ctx.strokeRect(labelX, labelY, labelW, labelH)

        ctx.fillStyle = this.skin.connections.labelText
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        for (let i = 0; i < lines.length; i++) {
          const lineY = labelY + paddingY + lineHeight / 2 + i * lineHeight
          ctx.fillText(lines[i], labelCX, lineY)
        }
      }

      // Flow step badge — square for 8-bit
      if (flowState === 'active' && this.currentFlowId) {
        const flow = this.flows.find((f) => f.id === this.currentFlowId)
        if (flow) {
          const stepNum = this.currentFlowStepIndex + 1
          const badgePt = this.getPathPoint(geom, 0.3)
          const badgeSize = 14
          const badgeX = badgePt.x - badgeSize / 2
          const badgeY = badgePt.y - badgeSize / 2

          const badgeColor = this.getCurrentFlowStepColor() || this.skin.flowBadgeFallback
          ctx.fillStyle = badgeColor
          ctx.fillRect(badgeX, badgeY, badgeSize, badgeSize)

          ctx.fillStyle = '#FFFFFF'
          ctx.font = this.getCanvasFont('bold', 10)
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(stepNum), badgePt.x, badgePt.y + 0.5)
        }
      }

      ctx.setLineDash([])
      ctx.restore()
      return
    }

    const fastMode = this.isInteracting || this.frameQuality.isDegraded()
    // Connections render a double curve when the shape-level doubleStroke is on
    // (dark cyberpunk / graffiti) OR when the skin defines connection-only double
    // colours. The latter lets a skin keep its shapes single-bordered while still
    // drawing the yellow/cyan-style double line on connections (light cyberpunk).
    const connDoubleColors = !!(this.skin.connections.doubleOuterColor || this.skin.connections.doubleInnerColor)
    const hasDoubleStroke = !fastMode && (this.skin.renderStyle.doubleStroke?.enabled || connDoubleColors)
    const hasChromatic = !fastMode && this.skin.renderStyle.chromaticAberration?.enabled

    if (!hasDoubleStroke && !hasChromatic) {
      this.traceConnectionPath(ctx, geom)
      ctx.stroke()
    }

    // Chromatic aberration (cyberpunk skin) — cyan left/up, yellow right/down, primary centered
    if (hasChromatic && !hasDoubleStroke) {
      const ca = this.skin.renderStyle.chromaticAberration!
      const primaryStroke = ctx.strokeStyle as string
      const primaryLineWidth = ctx.lineWidth

      // Cyan offset up-left
      ctx.save()
      ctx.strokeStyle = this.skin.connections.highlight
      ctx.lineWidth = primaryLineWidth
      ctx.translate(-ca.offset * 0.7, -ca.offset * 0.7)
      ctx.globalAlpha = 0.5
      this.traceConnectionPath(ctx, geom)
      ctx.stroke()
      ctx.restore()

      // Yellow offset down-right
      ctx.save()
      ctx.strokeStyle = ca.secondaryColor
      ctx.lineWidth = primaryLineWidth
      ctx.translate(ca.offset * 0.7, ca.offset * 0.7)
      ctx.globalAlpha = 0.4
      this.traceConnectionPath(ctx, geom)
      ctx.stroke()
      ctx.restore()

      // Primary centered
      ctx.save()
      ctx.strokeStyle = primaryStroke
      ctx.lineWidth = primaryLineWidth
      ctx.globalAlpha = 0.85
      this.traceConnectionPath(ctx, geom)
      ctx.stroke()
      ctx.restore()
    }

    // Double curve — cyberpunk (colored + offset) or graffiti (offset same color)
    if (hasDoubleStroke) {
      const ds = this.skin.renderStyle.doubleStroke!
      const connColor = isHighlighted ? this.skin.connections.highlight : (isHovered ? this.skin.connections.hover : flowActiveColor)
      const isCyberpunkDouble = ds.outerColor || ds.innerColor
      const offset = ds.offset ?? 2

      // Connections may override the double-curve colours so they keep a
      // yellow+cyan line even when the object border uses a same-colour stroke.
      const connOuter = this.skin.connections.doubleOuterColor ?? ds.outerColor
      const connInner = this.skin.connections.doubleInnerColor ?? ds.innerColor
      if (isCyberpunkDouble) {
        // Outer (yellow) — offset up
        ctx.save()
        ctx.strokeStyle = connOuter || connColor
        ctx.lineWidth = ds.outerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        this.traceConnectionPath(ctx, geom, 0, -offset * 0.5)
        ctx.stroke()
        ctx.restore()

        // Inner (cyan) — offset down
        ctx.save()
        ctx.strokeStyle = connInner || connColor
        ctx.lineWidth = ds.innerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        this.traceConnectionPath(ctx, geom, 0, offset * 0.5)
        ctx.stroke()
        ctx.restore()
      } else {
        // Graffiti sketch-style — inner + outer, offset in opposite directions
        // Inner curve — very slight offset inward (down)
        ctx.save()
        ctx.strokeStyle = connColor
        ctx.lineWidth = ds.innerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        this.traceConnectionPath(ctx, geom, 0, 0.5)
        ctx.stroke()
        ctx.restore()

        // Outer curve — smaller offset outward (up) for closer lines
        ctx.save()
        ctx.strokeStyle = connColor
        ctx.lineWidth = ds.outerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        this.traceConnectionPath(ctx, geom, 0, -1.5)
        ctx.stroke()
        ctx.restore()
      }
    }

    ctx.setLineDash([])

    // Label
    if (conn.label) {
      const isDraggingThisLabel = this.isDraggingLabel && this.draggingLabelConnId === conn.id
      const t = isDraggingThisLabel ? this.dragLabelCurrentT : (conn.labelPosition ?? 0.5)
      const offset = isDraggingThisLabel ? this.dragLabelCurrentOffset : Math.max(-40, Math.min(40, conn.labelOffset ?? 12))
      const labelPt = this.getPathPoint(geom, t)
      const tangent = this.getPathTangent(geom, t)
      // Normal points 90° CCW from tangent
      const normalX = -tangent.y
      const normalY = tangent.x
      const labelCX = labelPt.x + normalX * offset
      const labelCY = labelPt.y + normalY * offset

      const lines = conn.label.split('\n')
      const lineHeight = 12
      const paddingX = 8
      const paddingY = 4

      ctx.font = this.getCanvasFont('400', 10)
      let maxTextWidth = 0
      for (const line of lines) {
        const w = ctx.measureText(line).width
        if (w > maxTextWidth) maxTextWidth = w
      }

      const labelW = maxTextWidth + paddingX * 2
      const labelH = lines.length * lineHeight + paddingY * 2
      const labelX = labelCX - labelW / 2
      const labelY = labelCY - labelH / 2

      // White background with subtle border
      ctx.fillStyle = this.skin.connections.labelBg
      ctx.strokeStyle = this.skin.connections.labelStroke
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(labelX, labelY, labelW, labelH, 4)
      ctx.fill()
      ctx.stroke()

      ctx.fillStyle = this.skin.connections.labelText
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let i = 0; i < lines.length; i++) {
        const lineY = labelY + paddingY + lineHeight / 2 + i * lineHeight
        ctx.fillText(lines[i], labelCX, lineY)
      }
    }

    // Flow step number badge
    if (flowState === 'active' && this.currentFlowId) {
      const flow = this.flows.find((f) => f.id === this.currentFlowId)
      if (flow) {
        const stepNum = this.currentFlowStepIndex + 1
        const badgeR = 10
        const badgePt = this.getPathPoint(geom, 0.3)
        const badgeX = badgePt.x
        const badgeY = badgePt.y

        const badgeColor = this.getCurrentFlowStepColor() || this.skin.flowBadgeFallback
        ctx.fillStyle = badgeColor
        ctx.beginPath()
        ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = '#FFFFFF'
        ctx.font = this.getCanvasFont('bold', 10)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(stepNum), badgeX, badgeY + 0.5)
      }
    }

    // Highlight animation effect on selected / highlighted connection. In a
    // layered frame (see render) it is deferred and drawn between the frozen
    // layers, so the next animation frames can redraw it alone.
    if (isHighlighted && !this.frameQuality.isDegraded()) {
      if (this.deferredEffects) this.deferredEffects.push({ geom, alpha })
      else this.renderConnectionHighlightEffect(ctx, geom)
    }

    ctx.restore()
  }

  private getBezierPoint(
    t: number,
    fromX: number,
    fromY: number,
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    toX: number,
    toY: number
  ) {
    const a = 1 - t
    const x = Math.pow(a, 3) * fromX + 3 * Math.pow(a, 2) * t * cp1x + 3 * a * Math.pow(t, 2) * cp2x + Math.pow(t, 3) * toX
    const y = Math.pow(a, 3) * fromY + 3 * Math.pow(a, 2) * t * cp1y + 3 * a * Math.pow(t, 2) * cp2y + Math.pow(t, 3) * toY
    return { x, y }
  }

  private getBezierTangent(
    t: number,
    fromX: number, fromY: number,
    cp1x: number, cp1y: number,
    cp2x: number, cp2y: number,
    toX: number, toY: number
  ) {
    const a = 1 - t
    const b = t
    // Cubic Bezier derivative: 3(1-t)^2(P1-P0) + 6(1-t)t(P2-P1) + 3t^2(P3-P2)
    const dx = 3 * a * a * (cp1x - fromX) + 6 * a * b * (cp2x - cp1x) + 3 * b * b * (toX - cp2x)
    const dy = 3 * a * a * (cp1y - fromY) + 6 * a * b * (cp2y - cp1y) + 3 * b * b * (toY - cp2y)
    const len = Math.hypot(dx, dy)
    if (len === 0) return { x: 1, y: 0 }
    return { x: dx / len, y: dy / len }
  }

  private drawPixelatedBezier(
    ctx: CanvasRenderingContext2D,
    fromX: number,
    fromY: number,
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    toX: number,
    toY: number,
    pixelSize: number
  ) {
    const dist = Math.hypot(toX - fromX, toY - fromY)
    const stepSpacing = pixelSize * 2
    const steps = Math.max(8, Math.ceil(dist / stepSpacing))
    const snap = (v: number) => Math.round(v / pixelSize) * pixelSize
    const blockSize = pixelSize * 2

    let lastGX: number | null = null
    let lastGY: number | null = null

    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const pt = this.getBezierPoint(t, fromX, fromY, cp1x, cp1y, cp2x, cp2y, toX, toY)
      const gx = snap(pt.x)
      const gy = snap(pt.y)
      if (gx !== lastGX || gy !== lastGY) {
        ctx.fillRect(gx, gy, blockSize, blockSize)
        lastGX = gx
        lastGY = gy
      }
    }
  }


  private renderConnectionHighlightEffect(ctx: CanvasRenderingContext2D, geom: ConnectionGeometry) {
    if (!this.connectionAnimationsEnabled || this.connectionHighlightStyle === 'none') {
      return
    }

    // Overall endpoints used for gradient direction / perpendicular jitter (approximate
    // for waypointed paths). Point sampling + stroking below follow the full path.
    const fromX = geom.fromEdge.x
    const fromY = geom.fromEdge.y
    const toX = geom.toEdge.x
    const toY = geom.toEdge.y

    const time = this.connectionAnimationTime
    const style = this.connectionHighlightStyle
    // Theme-driven colors: the blue-family styles read `base`/`tint`; the woven
    // `strands` style reads `strandColors`. Each falls back to the classic blue
    // when the active theme doesn't override it (see connectionAnimation.ts).
    const { color: base, highlight: tint, strands: strandColors, electric: electricColor } = resolveConnectionAnimation(this.skin)

    switch (style) {
      case 'traveling-dot': {
        const cycle = 1500
        const animT = (time % cycle) / cycle
        const pos = this.getPathPoint(geom, animT)

        ctx.fillStyle = hexToRgba(base, 0.25)
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = '#FFFFFF'
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = base
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, 2.5, 0, Math.PI * 2)
        ctx.fill()
        break
      }

      case 'gradient-flow': {
        const cycle = 2000
        const offset = (time % cycle) / cycle
        const gradient = ctx.createLinearGradient(fromX, fromY, toX, toY)
        gradient.addColorStop((offset + 0.0) % 1, hexToRgba(base, 0))
        gradient.addColorStop((offset + 0.25) % 1, hexToRgba(base, 0.5))
        gradient.addColorStop((offset + 0.5) % 1, hexToRgba(tint, 0.95))
        gradient.addColorStop((offset + 0.75) % 1, hexToRgba(base, 0.5))
        gradient.addColorStop((offset + 0.999) % 1, hexToRgba(base, 0))

        ctx.strokeStyle = gradient
        ctx.lineWidth = 4
        this.traceConnectionPath(ctx, geom)
        ctx.stroke()
        break
      }

      case 'lightning': {
        const cycle = 1600
        const sweep = (time % cycle) / cycle
        // Bolt grows from source (t=0) toward target (t=1)
        const maxT = sweep
        const timeSeed = time * 0.018

        const segments = 24
        for (let bolt = 0; bolt < 2; bolt++) {
          ctx.beginPath()
          let started = false
          for (let i = 0; i <= segments; i++) {
            const t = i / segments
            if (t > maxT) break
            const base = this.getPathPoint(geom, t)
            const envelope = Math.sin((t / Math.max(0.001, maxT)) * Math.PI)
            const jitter = Math.sin(t * 40 + timeSeed + bolt * 3.14) * 5 * envelope
            const perpAngle = Math.atan2(toY - fromY, toX - fromX) + Math.PI / 2
            const bx = base.x + Math.cos(perpAngle) * jitter
            const by = base.y + Math.sin(perpAngle) * jitter
            if (!started) {
              ctx.moveTo(bx, by)
              started = true
            } else {
              ctx.lineTo(bx, by)
            }
          }
          if (started) {
            const alpha = bolt === 0 ? 0.6 : 0.35
            ctx.strokeStyle = hexToRgba(tint, alpha)
            ctx.lineWidth = bolt === 0 ? 2.5 : 4
            ctx.stroke()
          }
        }

        // Bright strike flash at the leading edge
        if (maxT > 0.01) {
          const leadPos = this.getPathPoint(geom, Math.min(1, maxT))
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
          ctx.beginPath()
          ctx.arc(leadPos.x, leadPos.y, 3, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = hexToRgba(tint, 0.4)
          ctx.beginPath()
          ctx.arc(leadPos.x, leadPos.y, 7, 0, Math.PI * 2)
          ctx.fill()
        }
        break
      }

      case 'pulse': {
        const cycle = 1400
        const pulseT = (time % cycle) / cycle
        for (let i = 0; i < 4; i++) {
          const ringT = (pulseT + i / 4) % 1
          const alpha = (1 - ringT) * 0.35
          const width = 2 + ringT * 12
          ctx.strokeStyle = hexToRgba(base, alpha)
          ctx.lineWidth = width
          this.traceConnectionPath(ctx, geom)
          ctx.stroke()
        }

        // Bright center line
        ctx.strokeStyle = hexToRgba(tint, 0.8)
        ctx.lineWidth = 2.5
        this.traceConnectionPath(ctx, geom)
        ctx.stroke()
        break
      }

      case 'sparkle': {
        const sparkleCount = 6
        const cycle = 1800
        for (let i = 0; i < sparkleCount; i++) {
          const offset = i / sparkleCount
          const localT = ((time + offset * cycle) % cycle) / cycle
          const pos = this.getPathPoint(geom, localT)
          const fade = Math.sin(localT * Math.PI)

          ctx.fillStyle = `rgba(255, 255, 255, ${fade})`
          ctx.beginPath()
          ctx.arc(pos.x, pos.y, 1.5 + fade * 1.5, 0, Math.PI * 2)
          ctx.fill()

          ctx.fillStyle = hexToRgba(tint, fade * 0.5)
          ctx.beginPath()
          ctx.arc(pos.x, pos.y, 3 + fade * 3, 0, Math.PI * 2)
          ctx.fill()
        }

        // Subtle glow line underneath
        ctx.strokeStyle = hexToRgba(base, 0.2)
        ctx.lineWidth = 4
        this.traceConnectionPath(ctx, geom)
        ctx.stroke()
        break
      }

      case 'energy-beam': {
        const intensity = 0.6 + 0.4 * Math.sin(time * 0.004)

        // Outer aura
        ctx.strokeStyle = hexToRgba(base, 0.2 * intensity)
        ctx.lineWidth = 14
        this.traceConnectionPath(ctx, geom)
        ctx.stroke()

        // Mid glow
        ctx.strokeStyle = hexToRgba(lightenHex(base, 0.2), 0.4 * intensity)
        ctx.lineWidth = 8
        ctx.stroke()

        // Core beam
        ctx.strokeStyle = hexToRgba(tint, 0.9 * intensity)
        ctx.lineWidth = 3
        ctx.stroke()

        // Traveling energy packet
        const cycle = 1200
        const animT = (time % cycle) / cycle
        const pos = this.getPathPoint(geom, animT)

        ctx.fillStyle = `rgba(255, 255, 255, ${0.8 * intensity})`
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = hexToRgba(tint, 0.4 * intensity)
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2)
        ctx.fill()
        break
      }

      case 'neon-dash': {
        const dashLen = 10
        const gapLen = 6
        const totalLen = dashLen + gapLen
        const speed = 0.06
        const offset = -((time * speed) % totalLen)

        ctx.save()
        ctx.setLineDash([dashLen, gapLen])
        ctx.lineDashOffset = offset

        // Neon glow layers
        ctx.shadowColor = base
        ctx.shadowBlur = 12
        ctx.strokeStyle = hexToRgba(base, 0.5)
        ctx.lineWidth = 5
        this.traceConnectionPath(ctx, geom)
        ctx.stroke()

        ctx.shadowBlur = 6
        ctx.strokeStyle = hexToRgba(tint, 0.8)
        ctx.lineWidth = 3
        ctx.stroke()

        ctx.shadowBlur = 0
        ctx.strokeStyle = this.skin.anchors.stroke
        ctx.lineWidth = 1.5
        ctx.stroke()

        ctx.restore()
        break
      }

      case 'strands': {
        // Rope of luminous strands helically wound around the connection, colored
        // from the active theme's palette. The render lives in a pure helper so it
        // can be exercised against any path sampler (see connectionAnimation.ts);
        // here we feed it the live ConnectionGeometry samplers. On a dark canvas we
        // switch on additive blending so overlaps bloom toward white like the
        // reference; on a light canvas that would wash out, so it stays off.
        // Size the rope to the connection: a long run gets a wider, airier weave,
        // a short one stays tight. Clamped so it never collapses or overwhelms.
        const strandSpan = Math.hypot(toX - fromX, toY - fromY)
        drawStrands(ctx, {
          pointAt: (t) => this.getPathPoint(geom, t),
          // Central-difference tangent off the (proven) point sampler — robust for
          // every path shape, including waypointed ones.
          tangentAt: (t) => {
            const a = this.getPathPoint(geom, Math.max(0, t - 0.01))
            const b = this.getPathPoint(geom, Math.min(1, t + 0.01))
            const dx = b.x - a.x, dy = b.y - a.y
            const len = Math.hypot(dx, dy) || 1
            return { x: dx / len, y: dy / len }
          },
          colors: strandColors,
          timeMs: time,
          // Tuned from a playground config (amplitude .25, waviness .65,
          // thickness .35, glow .7, taper 5.6, spread .2, intensity .2, scale .55,
          // speed .45), mapped to px against the connection length.
          radius: Math.max(4, Math.min(14, strandSpan * 0.021)),
          twist: 1.04,
          thickness: 1.35,
          glow: 2.7,
          taper: 3.1,
          speed: 0.002,
          spread: 0.2,
          intensity: 0.2,
          additive: isDarkColor(this.skin.canvas.bg),
          spine: true, // the connection line is part of the effect
        })
        break
      }

      case 'electric': {
        // A turbulent electric arc wriggling along the line — the canvas take on the
        // SVG turbulence/displacement "electric border". The path is displaced
        // perpendicular by a summed-sine fractal (three octaves) that flows over
        // time, tapered to nothing at the ends so it meets the shapes, and drawn as
        // an outer glow → mid arc → white-hot core, with a subtle flicker.
        const N = 64
        const tt = time * 0.001
        const span = Math.hypot(toX - fromX, toY - fromY)
        const amp = Math.max(3, Math.min(8, span * 0.02))
        const flick = 0.72 + 0.28 * Math.sin(time * 0.021) * Math.sin(time * 0.037)
        const ec = electricColor

        const traceArc = (aScale: number, seed: number, spd: number) => {
          ctx.beginPath()
          for (let i = 0; i <= N; i++) {
            const t = i / N
            const p = this.getPathPoint(geom, t)
            const tan = this.getPathTangent(geom, t)
            const nx = -tan.y, ny = tan.x
            const env = Math.sin(t * Math.PI) // → 0 at both ends
            const noise =
              Math.sin(t * 8 * Math.PI + seed + tt * spd) +
              0.55 * Math.sin(t * 17 * Math.PI + seed * 1.7 - tt * spd * 1.4) +
              0.3 * Math.sin(t * 33 * Math.PI + seed * 2.3 + tt * spd * 1.9)
            const d = noise * amp * aScale * env
            const x = p.x + nx * d, y = p.y + ny * d
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
          }
        }

        ctx.save()
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        // outer glow
        ctx.shadowColor = ec
        ctx.shadowBlur = 15
        ctx.strokeStyle = hexToRgba(ec, 0.42 * flick)
        ctx.lineWidth = 4.5
        traceArc(1, 0, 7); ctx.stroke()
        // second, tighter arc offset the other way
        ctx.shadowBlur = 9
        ctx.strokeStyle = hexToRgba(ec, 0.6 * flick)
        ctx.lineWidth = 2.4
        traceArc(0.62, 2.4, -6); ctx.stroke()
        // white-hot core
        ctx.shadowBlur = 6
        ctx.strokeStyle = hexToRgba(lightenHex(ec, 0.72), 0.95 * flick)
        ctx.lineWidth = 1.4
        traceArc(1, 0, 7); ctx.stroke()
        ctx.restore()
        break
      }
    }
  }

  private renderAnchorDotsForShape(
    ctx: CanvasRenderingContext2D,
    id: string,
    cursorX: number,
    cursorY: number,
    skipAnchorIndex?: number
  ) {
    const obj = this.objects.find((o) => o.id === id)
    let cx: number, cy: number, w: number, h: number
    if (obj) {
      cx = obj.position.x + obj.size.width / 2
      cy = obj.position.y + obj.size.height / 2
      w = obj.size.width
      h = obj.size.height
    } else {
      const group = this.groups.find((g) => g.id === id)
      if (!group) return
      const bounds = this.getGroupBounds(group)
      if (!bounds) return
      cx = bounds.x + bounds.width / 2
      cy = bounds.y + bounds.height / 2
      w = bounds.width
      h = bounds.height
    }

    const activeIndices = this.getActiveAnchorIndices(id)
    let nearestIdx = -1
    let nearestDist = Infinity
    for (const i of activeIndices) {
      if (i === skipAnchorIndex) continue
      const pt = this.getAnchorPoint(cx, cy, w, h, i)
      const dist = Math.hypot(cursorX - pt.x, cursorY - pt.y)
      if (dist < nearestDist) {
        nearestDist = dist
        nearestIdx = i
      }
    }

    ctx.save()
    for (const i of activeIndices) {
      if (i === skipAnchorIndex) continue
      const pt = this.getAnchorPoint(cx, cy, w, h, i)
      const isNearest = i === nearestIdx
      ctx.fillStyle = isNearest ? this.skin.anchors.colorHighlighted : this.skin.anchors.color
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, isNearest ? 6 : 4, 0, Math.PI * 2)
      ctx.fill()
      // White ring for contrast
      ctx.strokeStyle = this.skin.anchors.stroke
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    ctx.restore()
  }

  private renderConnectionEndpointDragPreview(ctx: CanvasRenderingContext2D) {
    if (!this.draggingConnId || !this.draggingConnEndpoint) return
    const conn = this.connections.find((c) => c.id === this.draggingConnId)
    if (!conn) return

    // Fixed endpoint
    const fixedEnd = this.draggingConnEndpoint === 'source' ? 'target' : 'source'
    const fixedConnId = fixedEnd === 'source' ? conn.fromId : conn.toId
    const fixedAnchor = fixedEnd === 'source' ? conn.fromAnchor : conn.toAnchor
    const fixed = this.getConnectionEndpoint(fixedConnId, fixedAnchor)
    if (!fixed) return

    const fromX = fixed.cx
    const fromY = fixed.cy
    const toX = this.connDragPreview.x
    const toY = this.connDragPreview.y

    const fromEdge = fixed.face
      ? { x: fromX, y: fromY, face: fixed.face }
      : this.getEdgePoint(fromX, fromY, toX, toY, fixed.width, fixed.height)

    // Preview line always follows the mouse; hovered shape is only for anchor dots
    const toEdge = this.estimateEdgePoint(toX, toY, fromEdge.x, fromEdge.y)

    const normals = {
      top: { x: 0, y: -1 },
      bottom: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    }
    const sepX = Math.abs(toEdge.x - fromEdge.x)
    const sepY = Math.abs(toEdge.y - fromEdge.y)
    const connectionDist = Math.hypot(sepX, sepY)
    const controlDist = Math.min(Math.max(connectionDist * 0.4, 30), 150)

    const fromNormal = normals[fromEdge.face]
    const toNormal = normals[toEdge.face]

    const cp1x = fromEdge.x + fromNormal.x * controlDist
    const cp1y = fromEdge.y + fromNormal.y * controlDist
    const cp2x = toEdge.x + toNormal.x * controlDist
    const cp2y = toEdge.y + toNormal.y * controlDist

    ctx.save()
    ctx.strokeStyle = this.skin.connections.normal
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(fromEdge.x, fromEdge.y)
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, toEdge.x, toEdge.y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }

  private estimateEdgePoint(
    toX: number,
    toY: number,
    fromX: number,
    fromY: number
  ): { x: number; y: number; face: 'top' | 'bottom' | 'left' | 'right' } {
    const angle = Math.atan2(toY - fromY, toX - fromX)
    let face: 'top' | 'bottom' | 'left' | 'right'
    if (Math.abs(angle) <= Math.PI / 4) {
      face = 'left'
    } else if (Math.abs(angle) >= (3 * Math.PI) / 4) {
      face = 'right'
    } else if (angle > 0) {
      face = 'top'
    } else {
      face = 'bottom'
    }
    return { x: toX, y: toY, face }
  }

  private renderConnectionPreview(
    ctx: CanvasRenderingContext2D,
    fromId: string,
    to: { x: number; y: number }
  ) {
    const from = this.getConnectionEndpoint(fromId)
    if (!from) return

    const fromEdge = this.getEdgePoint(from.cx, from.cy, to.x, to.y, from.width, from.height)
    const toEdge = this.estimateEdgePoint(to.x, to.y, fromEdge.x, fromEdge.y)

    const normals = {
      top: { x: 0, y: -1 },
      bottom: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    }
    const sepX = Math.abs(toEdge.x - fromEdge.x)
    const sepY = Math.abs(toEdge.y - fromEdge.y)
    const connectionDist = Math.hypot(sepX, sepY)
    const controlDist = Math.min(Math.max(connectionDist * 0.4, 30), 150)

    const fromNormal = normals[fromEdge.face]
    const toNormal = normals[toEdge.face]

    const cp1x = fromEdge.x + fromNormal.x * controlDist
    const cp1y = fromEdge.y + fromNormal.y * controlDist
    const cp2x = toEdge.x + toNormal.x * controlDist
    const cp2y = toEdge.y + toNormal.y * controlDist

    ctx.save()
    ctx.strokeStyle = this.skin.connections.normal
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 4])

    if (this.themeBridge.pixelSnap != null) {
      const ps = this.skin.renderStyle.pixelSize || 2
      ctx.fillStyle = ctx.strokeStyle as string
      this.drawPixelatedBezier(ctx, fromEdge.x, fromEdge.y, cp1x, cp1y, cp2x, cp2y, toEdge.x, toEdge.y, ps)
    } else {
      ctx.beginPath()
      ctx.moveTo(fromEdge.x, fromEdge.y)
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, toEdge.x, toEdge.y)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.restore()
  }

  private renderShapeAnchors(
    ctx: CanvasRenderingContext2D,
    id: string,
    options?: {
      hoveredIndex?: number | null
      highlightedIndex?: number
      skipIndex?: number
    }
  ) {
    const obj = this.objects.find((o) => o.id === id)
    let cx: number, cy: number, w: number, h: number
    if (obj) {
      cx = obj.position.x + obj.size.width / 2
      cy = obj.position.y + obj.size.height / 2
      w = obj.size.width
      h = obj.size.height
    } else {
      const group = this.groups.find((g) => g.id === id)
      if (!group) return
      const bounds = this.getGroupBounds(group)
      if (!bounds) return
      cx = bounds.x + bounds.width / 2
      cy = bounds.y + bounds.height / 2
      w = bounds.width
      h = bounds.height
    }

    const activeIndices = this.getActiveAnchorIndices(id)
    ctx.save()
    for (const i of activeIndices) {
      if (i === options?.skipIndex) continue
      const pt = this.getAnchorPoint(cx, cy, w, h, i)
      const isHovered = options?.hoveredIndex === i
      const isHighlighted = options?.highlightedIndex === i
      const baseRadius = isHovered ? 7 : (isHighlighted ? 6 : 4)
      const radius = this.viewport.scale < 1 ? Math.min(baseRadius / this.viewport.scale, 12) : baseRadius
      ctx.fillStyle = isHovered || isHighlighted ? this.skin.anchors.colorHighlighted : this.skin.anchors.color
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = this.skin.anchors.stroke
      ctx.lineWidth = 1.5
      ctx.stroke()

      if (isHovered) {
        // Draw plus icon
        ctx.strokeStyle = this.skin.anchors.stroke
        ctx.lineWidth = 1.5
        ctx.lineCap = 'round'
        const plusSize = 4
        ctx.beginPath()
        ctx.moveTo(pt.x - plusSize, pt.y)
        ctx.lineTo(pt.x + plusSize, pt.y)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(pt.x, pt.y - plusSize)
        ctx.lineTo(pt.x, pt.y + plusSize)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  private renderAnchorDragPreview(ctx: CanvasRenderingContext2D) {
    if (!this.connectionFrom || this.connectionFromAnchor === null) return
    const from = this.getConnectionEndpoint(this.connectionFrom, this.connectionFromAnchor)
    if (!from) return

    const toX = this.connDragPreview.x
    const toY = this.connDragPreview.y

    const fromEdge = from.face
      ? { x: from.cx, y: from.cy, face: from.face }
      : this.getEdgePoint(from.cx, from.cy, toX, toY, from.width, from.height)

    // Preview line always follows the mouse; hovered shape is only for anchor dots
    const toEdge = this.estimateEdgePoint(toX, toY, fromEdge.x, fromEdge.y)

    const normals = {
      top: { x: 0, y: -1 },
      bottom: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    }
    const sepX = Math.abs(toEdge.x - fromEdge.x)
    const sepY = Math.abs(toEdge.y - fromEdge.y)
    const connectionDist = Math.hypot(sepX, sepY)
    const controlDist = Math.min(Math.max(connectionDist * 0.4, 30), 150)

    const fromNormal = normals[fromEdge.face]
    const toNormal = normals[toEdge.face]

    const cp1x = fromEdge.x + fromNormal.x * controlDist
    const cp1y = fromEdge.y + fromNormal.y * controlDist
    const cp2x = toEdge.x + toNormal.x * controlDist
    const cp2y = toEdge.y + toNormal.y * controlDist

    ctx.save()
    ctx.strokeStyle = this.skin.connections.normal
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 4])

    if (this.themeBridge.pixelSnap != null) {
      const ps = this.skin.renderStyle.pixelSize || 2
      ctx.fillStyle = ctx.strokeStyle as string
      this.drawPixelatedBezier(ctx, fromEdge.x, fromEdge.y, cp1x, cp1y, cp2x, cp2y, toEdge.x, toEdge.y, ps)
    } else {
      ctx.beginPath()
      ctx.moveTo(fromEdge.x, fromEdge.y)
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, toEdge.x, toEdge.y)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.restore()
  }

  private hitTestShapeAnchor(
    shapeOrGroupId: string,
    x: number,
    y: number
  ): { shapeId: string; anchorIndex: number } | null {
    const obj = this.objectMap.get(shapeOrGroupId)
    let cx: number, cy: number, w: number, h: number
    if (obj) {
      cx = obj.position.x + obj.size.width / 2
      cy = obj.position.y + obj.size.height / 2
      w = obj.size.width
      h = obj.size.height
    } else {
      const group = this.groupMap.get(shapeOrGroupId)
      if (!group) return null
      const bounds = this.getGroupBounds(group)
      if (!bounds) return null
      cx = bounds.x + bounds.width / 2
      cy = bounds.y + bounds.height / 2
      w = bounds.width
      h = bounds.height
    }

    const threshold = 10 / this.viewport.scale
    const activeIndices = this.getActiveAnchorIndices(shapeOrGroupId)
    for (const i of activeIndices) {
      const pt = this.getAnchorPoint(cx, cy, w, h, i)
      if (Math.hypot(x - pt.x, y - pt.y) < threshold) {
        return { shapeId: shapeOrGroupId, anchorIndex: i }
      }
    }
    return null
  }

  private renderArrowhead(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    cp2x: number,
    cp2y: number,
    color: string
  ) {
    const angle = Math.atan2(y - cp2y, x - cp2x)
    const size = 14
    // Mirror the connection-line gate: a double arrowhead whenever the shape
    // doubleStroke is on OR the skin defines connection-only double colours.
    const connDoubleColors = !!(this.skin.connections.doubleOuterColor || this.skin.connections.doubleInnerColor)
    const hasDoubleStroke = !this.isInteracting && (this.skin.renderStyle.doubleStroke?.enabled || connDoubleColors)

    if (!hasDoubleStroke) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(
        x - size * Math.cos(angle - Math.PI / 6),
        y - size * Math.sin(angle - Math.PI / 6)
      )
      ctx.lineTo(
        x - size * Math.cos(angle + Math.PI / 6),
        y - size * Math.sin(angle + Math.PI / 6)
      )
      ctx.closePath()
      ctx.fill()
    }

    // Double arrowhead — cyberpunk (colored + offset) or graffiti (rotated)
    if (hasDoubleStroke) {
      const ds = this.skin.renderStyle.doubleStroke!
      const isCyberpunkDouble = ds.outerColor || ds.innerColor
      const offset = ds.offset ?? 2

      const connOuter = this.skin.connections.doubleOuterColor ?? ds.outerColor
      const connInner = this.skin.connections.doubleInnerColor ?? ds.innerColor
      if (isCyberpunkDouble) {
        // Outer (yellow) — offset up-left
        ctx.save()
        ctx.strokeStyle = connOuter || color
        ctx.lineWidth = ds.outerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.translate(-offset * 0.5, -offset * 0.5)
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(
          x - size * Math.cos(angle - Math.PI / 6),
          y - size * Math.sin(angle - Math.PI / 6)
        )
        ctx.lineTo(
          x - size * Math.cos(angle + Math.PI / 6),
          y - size * Math.sin(angle + Math.PI / 6)
        )
        ctx.closePath()
        ctx.stroke()
        ctx.restore()

        // Inner (cyan) — offset down-right
        ctx.save()
        ctx.strokeStyle = connInner || color
        ctx.lineWidth = ds.innerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.translate(offset * 0.5, offset * 0.5)
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(
          x - size * Math.cos(angle - Math.PI / 6),
          y - size * Math.sin(angle - Math.PI / 6)
        )
        ctx.lineTo(
          x - size * Math.cos(angle + Math.PI / 6),
          y - size * Math.sin(angle + Math.PI / 6)
        )
        ctx.closePath()
        ctx.stroke()
        ctx.restore()
      } else {
        // Graffiti sketch-style — inner + outer outlines, both rotated
        // Inner arrowhead outline — same size with clockwise rotation
        ctx.save()
        ctx.strokeStyle = color
        ctx.lineWidth = ds.innerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.translate(x, y)
        ctx.rotate(0.05)
        ctx.translate(-x, -y)
        const inSize = size
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(
          x - inSize * Math.cos(angle - Math.PI / 6),
          y - inSize * Math.sin(angle - Math.PI / 6)
        )
        ctx.lineTo(
          x - inSize * Math.cos(angle + Math.PI / 6),
          y - inSize * Math.sin(angle + Math.PI / 6)
        )
        ctx.closePath()
        ctx.stroke()
        ctx.restore()

        // Outer arrowhead outline — only 1.5px larger with stronger counter-clockwise rotation
        ctx.save()
        ctx.strokeStyle = color
        ctx.lineWidth = ds.outerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.translate(x, y)
        ctx.rotate(-0.08)
        ctx.translate(-x, -y)
        const outSize = size + 1.5
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(
          x - outSize * Math.cos(angle - Math.PI / 6),
          y - outSize * Math.sin(angle - Math.PI / 6)
        )
        ctx.lineTo(
          x - outSize * Math.cos(angle + Math.PI / 6),
          y - outSize * Math.sin(angle + Math.PI / 6)
        )
        ctx.closePath()
        ctx.stroke()
        ctx.restore()
      }
    }
  }

  private renderConnectionArrowheads(ctx: CanvasRenderingContext2D, conn: Connection) {
    if (this.themeBridge.ownsOverlay('connectionLine')) return
    const geom = this.getConnectionGeometry(conn)
    if (!geom) return

    const toEdge = geom.toEdge
    const cp2x = geom.cp2x
    const cp2y = geom.cp2y
    const flowState = geom.flowState
    const isHovered = geom.isHovered
    const isHighlighted = geom.isHighlighted
    const alpha = geom.alpha

    ctx.save()
    ctx.globalAlpha = alpha

    const arrowColor = isHighlighted
      ? this.skin.connections.highlight
      : (isHovered
          ? this.skin.connections.hover
          : flowState === 'active'
            ? (this.getCurrentFlowStepColor() || this.skin.flowBadgeFallback)
            : conn.kind === 'lower' ? this.skin.connections.lower : this.skin.connections.normal)
    this.renderArrowhead(ctx, toEdge.x, toEdge.y, cp2x, cp2y, arrowColor)

    ctx.restore()
  }

  private renderPixelArrowhead(
    ctx: CanvasRenderingContext2D,
    tipX: number,
    tipY: number,
    _fromX: number,
    _fromY: number,
    color: string,
    pixelSize: number
  ) {
    const ps = pixelSize
    const snap = (v: number) => Math.round(v / ps) * ps
    ctx.fillStyle = color

    const cx = snap(tipX)
    const cy = snap(tipY)

    // Plus (+) shaped arrowhead — symmetric pixel-art cross
    const armLen = ps * 2
    // Horizontal bar
    ctx.fillRect(cx - armLen, cy, armLen * 2 + ps, ps)
    // Vertical bar
    ctx.fillRect(cx, cy - armLen, ps, armLen * 2 + ps)
  }

  private renderConnectionSourceAnchors(ctx: CanvasRenderingContext2D, conn: Connection) {
    const geom = this.getConnectionGeometry(conn)
    if (!geom) return

    const fromEdge = geom.fromEdge
    const isHovered = geom.isHovered
    const isHighlighted = geom.isHighlighted
    const alpha = geom.alpha

    const anchorColor = isHighlighted ? this.skin.anchors.colorHighlighted : (isHovered ? this.skin.anchors.colorHover : conn.kind === 'lower' ? this.skin.anchors.colorLower : this.skin.anchors.color)

    ctx.save()
    ctx.globalAlpha = alpha

    const isSelected = this.isConnectionSelected(conn.id)
    const baseDotRadius = isSelected ? 5 : 3.5
    const dotRadius = this.viewport.scale < 1 ? Math.min(baseDotRadius / this.viewport.scale, 12) : baseDotRadius

    // Source anchor (always visible)
    ctx.fillStyle = anchorColor
    if (this.themeBridge.pixelSnap != null) {
      const ps = this.skin.renderStyle.pixelSize || 2
      const dotSize = Math.ceil(dotRadius * 2 / ps) * ps
      ctx.fillRect(fromEdge.x - dotSize / 2, fromEdge.y - dotSize / 2, dotSize, dotSize)
    } else {
      ctx.beginPath()
      ctx.arc(fromEdge.x, fromEdge.y, dotRadius, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()
  }

  private renderConnectionDestinationAnchors(ctx: CanvasRenderingContext2D, conn: Connection) {
    const isSelected = this.isConnectionSelected(conn.id)
    if (!isSelected) return

    const geom = this.getConnectionGeometry(conn)
    if (!geom) return

    const toEdge = geom.toEdge
    const alpha = geom.alpha

    const anchorColor = this.skin.anchors.colorHighlighted

    ctx.save()
    ctx.globalAlpha = alpha

    // Destination anchor (only when this connection is selected)
    ctx.fillStyle = anchorColor
    if (this.themeBridge.pixelSnap != null) {
      const ps = this.skin.renderStyle.pixelSize || 2
      const destRadius = this.viewport.scale < 1 ? Math.min(5 / this.viewport.scale, 12) : 5
      const dotSize = Math.ceil(destRadius * 2 / ps) * ps
      ctx.fillRect(toEdge.x - dotSize / 2, toEdge.y - dotSize / 2, dotSize, dotSize)
    } else {
      ctx.beginPath()
      const destRadius = this.viewport.scale < 1 ? Math.min(5 / this.viewport.scale, 12) : 5
      ctx.arc(toEdge.x, toEdge.y, destRadius, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()
  }

  /** Draggable bend-point dots, shown only on the selected connection. */
  private renderConnectionWaypoints(ctx: CanvasRenderingContext2D, conn: Connection) {
    if (!this.isConnectionSelected(conn.id)) return
    const waypoints = this.getEffectiveWaypoints(conn)
    if (waypoints.length === 0) return
    const geom = this.getConnectionGeometry(conn)
    if (!geom) return

    const ringColor = this.skin.anchors.colorHighlighted
    const r = this.viewport.scale < 1 ? Math.min(5 / this.viewport.scale, 12) : 5

    ctx.save()
    ctx.globalAlpha = geom.alpha
    for (const wp of waypoints) {
      if (this.themeBridge.pixelSnap != null) {
        const ps = this.skin.renderStyle.pixelSize || 2
        const dotSize = Math.ceil((r * 2) / ps) * ps
        ctx.fillStyle = ringColor
        ctx.fillRect(wp.x - dotSize / 2, wp.y - dotSize / 2, dotSize, dotSize)
      } else {
        ctx.beginPath()
        ctx.arc(wp.x, wp.y, r, 0, Math.PI * 2)
        ctx.fillStyle = '#FFFFFF'
        ctx.fill()
        ctx.lineWidth = 2
        ctx.strokeStyle = ringColor
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  // --- Helpers ---

  private isObjectConnectedToHovered(obj: C4Object): boolean {
    if (!this.hoveredConnectionId) return false
    const conn = this.connectionMap.get(this.hoveredConnectionId)
    if (!conn) return false
    if (conn.fromId === obj.id || conn.toId === obj.id) return true
    // Check if object is in a group that's connected
    const fromGroup = this.groupMap.get(conn.fromId)
    if (fromGroup && fromGroup.objectIds.includes(obj.id)) return true
    const toGroup = this.groupMap.get(conn.toId)
    if (toGroup && toGroup.objectIds.includes(obj.id)) return true
    return false
  }

  private isInFocusMode(): boolean {
    return this.hasSelection()
  }

  /** Rebuild the hidden canonical-id lookup set. */
  private refreshHiddenTagNames() {
    this.hiddenTagIdsSet = new Set(this.hiddenTagIds)
  }

  private activeManagedPerspective(): ManagedPerspective | null {
    return this.bottomTab === 'technology' || this.bottomTab === 'status' || this.bottomTab === 'teams'
      ? this.bottomTab
      : null
  }

  private activeFocusedPerspectiveId(): string | null {
    const managed = this.activeManagedPerspective()
    if (managed) return this.managedPerspectiveInteractions[managed].focusedId
    return this.bottomTab === 'tags' ? this.focusedTagId : null
  }

  private objectPerspectiveHiddenState(obj: C4Object): { hidden: boolean; temporarilyRevealed: boolean } {
    const managed = this.activeManagedPerspective()
    if (managed) {
      const interaction = this.managedPerspectiveInteractions[managed]
      return resolveHiddenFacetState(obj, managed, new Set(interaction.hiddenIds), interaction.hoveredId)
    }
    if (this.bottomTab === 'tags') {
      return resolveHiddenTagState(obj, this.hiddenTagIdsSet, this.hoveredTagId)
    }
    return { hidden: false, temporarilyRevealed: false }
  }

  private isObjectHidden(obj: C4Object): boolean {
    return this.objectPerspectiveHiddenState(obj).hidden
  }

  private isConnectionHidden(conn: Connection): boolean {
    // When an object is selected (focus mode), connections with showOnFocus enabled
    // (default true) remain visible if they are connected to the selected shape.
    // This does NOT apply when a group or connection is selected.
    if (this.hasObjectSelection() && conn.showOnFocus !== false && this.isConnectionHighlighted(conn)) {
      return false
    }
    if (conn.hidden !== undefined) return true
    const managed = this.activeManagedPerspective()
    if (managed) {
      const interaction = this.managedPerspectiveInteractions[managed]
      if (resolveHiddenFacetState(conn, managed, new Set(interaction.hiddenIds), interaction.hoveredId).hidden) {
        return true
      }
    } else if (
      this.bottomTab === 'tags'
      && resolveHiddenTagState(conn, this.hiddenTagIdsSet, this.hoveredTagId).hidden
    ) {
      return true
    }
    const fromObj = this.objectMap.get(conn.fromId)
    const toObj = this.objectMap.get(conn.toId)
    if (fromObj && this.isObjectHidden(fromObj)) return true
    if (toObj && this.isObjectHidden(toObj)) return true
    return false
  }

  // Eagerly recompute tag-focus membership in one O(objects + connections) pass.
  // Called wherever the inputs change: setData() (objects/connections/tags) and
  // setTagInteractions() (focusedTagId).
  private rebuildTagFocusSets() {
    this.tagFocusSet.clear()
    this.tagConnectedSet.clear()
    this.tagFocusResolved = false
    const managed = this.activeManagedPerspective()
    if (managed) {
      const membership = resolveFacetFocusMembership(
        this.objects,
        this.connections,
        managed,
        this.managedPerspectiveInteractions[managed].focusedId,
      )
      this.tagFocusResolved = membership.resolved
      this.tagFocusSet = new Set(membership.matchingObjectIds)
      this.tagConnectedSet = new Set(membership.connectedObjectIds)
      return
    }
    if (this.bottomTab !== 'tags' || !this.focusedTagId) return
    const focusTag = this.tagById.get(this.focusedTagId)
    if (!focusTag) return // id set but no matching tag → every object is "focus"
    this.tagFocusResolved = true
    for (const obj of this.objects) {
      if (obj.tagAssignments?.[focusTag.tagId]) this.tagFocusSet.add(obj.id)
    }
    // An object is "connected" iff a connection joins it to an object that has the
    // focused tag (i.e. the other endpoint is in tagFocusSet). Group endpoints are
    // not objects, so they are excluded via objectMap — matching the original's
    // objectMap.get(...) guard.
    for (const conn of this.connections) {
      if (this.tagFocusSet.has(conn.fromId) && this.objectMap.has(conn.toId)) {
        this.tagConnectedSet.add(conn.toId)
      }
      if (this.tagFocusSet.has(conn.toId) && this.objectMap.has(conn.fromId)) {
        this.tagConnectedSet.add(conn.fromId)
      }
    }
  }

  private isObjectInTagFocus(obj: C4Object): 'focus' | 'connected' | 'none' {
    if (!this.activeFocusedPerspectiveId()) return 'focus'
    if (!this.tagFocusResolved) return 'focus'
    if (this.tagFocusSet.has(obj.id)) return 'focus'
    if (this.tagConnectedSet.has(obj.id)) return 'connected'
    return 'none'
  }

  private getObjectHoveredTag(obj: C4Object): Tag | null {
    if (this.bottomTab !== 'tags' || !this.hoveredTagId) return null
    const tag = this.tagById.get(this.hoveredTagId)
    if (tag && obj.tagAssignments?.[tag.tagId]) return tag
    return null
  }

  private isObjectInFocus(obj: C4Object): boolean {
    if (this.isObjectSelected(obj.id)) return true

    const singleConnId = this.getSingleSelectedConnectionId()
    if (singleConnId) {
      const conn = this.connectionMap.get(singleConnId)
      if (conn) {
        if (conn.fromId === obj.id || conn.toId === obj.id) return true
        const fromGroup = this.groupMap.get(conn.fromId)
        if (fromGroup && fromGroup.objectIds.includes(obj.id)) return true
        const toGroup = this.groupMap.get(conn.toId)
        if (toGroup && toGroup.objectIds.includes(obj.id)) return true
      }
    }

    if (this.hasObjectSelection()) {
      const adj = this.adjacencyMap.get(obj.id)
      if (adj) {
        for (const conn of adj) {
          if (conn.toId === obj.id && this.selectedObjectIds.has(conn.fromId)) return true
        }
      }
    }

    const selectedGroupId = this.selectedGroupIds.values().next().value
    if (selectedGroupId) {
      const group = this.groupMap.get(selectedGroupId)
      if (group) {
        if (group.objectIds.includes(obj.id)) return true
        const adj = this.adjacencyMap.get(obj.id)
        if (adj) {
          for (const conn of adj) {
            if (conn.toId === obj.id && conn.fromId === group.id) {
              return true
            }
          }
        }
      }
    }

    return false
  }

  private isConnectionHighlighted(conn: Connection): boolean {
    if (this.isConnectionSelected(conn.id)) return true
    if (this.selectedObjectIds.has(conn.fromId)) return true
    const selectedGroupId = this.selectedGroupIds.values().next().value
    if (selectedGroupId) {
      const group = this.groupMap.get(selectedGroupId)
      if (group) {
        if (conn.fromId === group.id) return true
      }
    }
    return false
  }

  private renderCommentBubbles(ctx: CanvasRenderingContext2D) {
    const typeColors: Record<string, { bg: string; border: string; text: string }> = {
      question: this.skin.comments.question,
      inaccuracy: this.skin.comments.inaccuracy,
      idea: this.skin.comments.idea,
    }

    for (const comment of this.comments) {
      if (comment.resolved) continue
      if (this.openCommentId === comment.id) continue

      const screen = this.worldToScreen(comment.position.x, comment.position.y)
      const x = screen.x
      const y = screen.y
      const radius = 14
      const colors = typeColors[comment.type] || typeColors.question
      const canvasWidth = this.canvas.width / this.dpr
      const canvasHeight = this.canvas.height / this.dpr
      if (x + radius < 0 || x - radius > canvasWidth || y + radius < 0 || y - radius > canvasHeight) continue

      ctx.save()

      // Shadow
      ctx.shadowColor = 'rgba(0, 0, 0, 0.15)'
      ctx.shadowBlur = 6
      ctx.shadowOffsetY = 2

      // Background circle
      ctx.fillStyle = colors.bg
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fill()

      ctx.shadowColor = 'transparent'

      // Border
      ctx.strokeStyle = colors.border + '66'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.stroke()

      // Icon
      ctx.fillStyle = colors.text
      ctx.font = this.getCanvasFont('bold', 13)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const iconChar = comment.type === 'question' ? '?' : comment.type === 'inaccuracy' ? '!' : 'i'
      ctx.fillText(iconChar, x, y + 1)

      // Reply count badge
      if (comment.replies.length > 0) {
        const badgeRadius = 7
        const badgeX = x + radius - 2
        const badgeY = y - radius + 2

        ctx.fillStyle = '#475569'
        ctx.beginPath()
        ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = '#ffffff'
        ctx.font = this.getCanvasFont('bold', 9)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(comment.replies.length), badgeX, badgeY + 1)
      }

      // Pinned indicator
      if (comment.pinned) {
        const pinRadius = 3
        const pinX = x - radius + 4
        const pinY = y - radius + 4
        ctx.fillStyle = colors.border
        ctx.beginPath()
        ctx.arc(pinX, pinY, pinRadius, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.restore()
    }
  }

  private hitTestComment(screenX: number, screenY: number): Comment | null {
    for (let i = this.comments.length - 1; i >= 0; i--) {
      const comment = this.comments[i]
      if (comment.resolved) continue
      if (this.openCommentId === comment.id) continue
      const screen = this.worldToScreen(comment.position.x, comment.position.y)
      const dist = Math.hypot(screenX - screen.x, screenY - screen.y)
      if (dist <= 16) {
        return comment
      }
    }
    return null
  }

  panToWorld(x: number, y: number) {
    const centerX = this.canvas.width / this.dpr / 2
    const centerY = this.canvas.height / this.dpr / 2
    this.viewport.x = centerX - x * this.viewport.scale
    this.viewport.y = centerY - y * this.viewport.scale
    this.scheduleRender()
  }

  screenToWorld(sx: number, sy: number) {
    return {
      x: (sx - this.viewport.x) / this.viewport.scale,
      y: (sy - this.viewport.y) / this.viewport.scale,
    }
  }

  worldToScreen(wx: number, wy: number) {
    return {
      x: wx * this.viewport.scale + this.viewport.x,
      y: wy * this.viewport.scale + this.viewport.y,
    }
  }

  getConnectionLabelBounds(connId: string): { x: number; y: number; width: number; height: number } | null {
    const conn = this.connectionMap.get(connId)
    if (!conn || !conn.label) return null

    const geom = this.getConnectionGeometry(conn)
    if (!geom) return null

    const isDraggingThisLabel = this.isDraggingLabel && this.draggingLabelConnId === conn.id
    const t = isDraggingThisLabel ? this.dragLabelCurrentT : (conn.labelPosition ?? 0.5)
    const offset = isDraggingThisLabel ? this.dragLabelCurrentOffset : Math.max(-40, Math.min(40, conn.labelOffset ?? 12))
    const labelPt = this.getPathPoint(geom, t)
    const tangent = this.getPathTangent(geom, t)
    const normalX = -tangent.y
    const normalY = tangent.x
    const labelCX = labelPt.x + normalX * offset
    const labelCY = labelPt.y + normalY * offset

    // Approximate text width: canvas font is 10px Inter
    const lines = conn.label.split('\n')
    const approxCharWidth = 6
    const maxLineLength = Math.max(...lines.map((l) => l.length))
    const textWidth = maxLineLength * approxCharWidth
    const lineHeight = 12
    const paddingX = 8
    const paddingY = 4
    const labelW = textWidth + paddingX * 2
    const labelH = lines.length * lineHeight + paddingY * 2
    const labelX = labelCX - labelW / 2
    const labelY = labelCY - labelH / 2

    return { x: labelX, y: labelY, width: labelW, height: labelH }
  }

  private hitTest(x: number, y: number, opts?: { skipHidden?: boolean }): C4Object | null {
    const candidates = [...this.ensureObjectSpatialIndex().query({ x, y, width: 0, height: 0 })]
      .sort((a, b) => b - a)
    for (const i of candidates) {
      const obj = this.objects[i]
      if (opts?.skipHidden && this.isObjectHidden(obj)) continue
      if (
        x >= obj.position.x &&
        x <= obj.position.x + obj.size.width &&
        y >= obj.position.y &&
        y <= obj.position.y + obj.size.height
      ) {
        return obj
      }
    }
    return null
  }

  private hitTestAnchorDot(x: number, y: number): { connId: string; end: 'source' | 'target' } | null {
    const singleConnId = this.getSingleSelectedConnectionId()
    if (!singleConnId) return null
    const conn = this.connectionMap.get(singleConnId)
    if (!conn) return null

    const from = this.getConnectionEndpoint(conn.fromId, conn.lockedToAnchors ? conn.fromAnchor : undefined)
    const to = this.getConnectionEndpoint(conn.toId, conn.lockedToAnchors ? conn.toAnchor : undefined)
    if (!from || !to) return null

    const threshold = 10 / this.viewport.scale

    // Source dot
    let fromEdge: { x: number; y: number }
    if (conn.lockedToAnchors && conn.fromAnchor !== undefined && from.face) {
      fromEdge = { x: from.cx, y: from.cy }
    } else {
      fromEdge = this.getEdgePoint(from.cx, from.cy, to.cx, to.cy, from.width, from.height)
    }
    if (Math.hypot(x - fromEdge.x, y - fromEdge.y) < threshold) {
      return { connId: conn.id, end: 'source' }
    }

    // Destination dot (only if selected)
    let toEdge: { x: number; y: number }
    if (conn.lockedToAnchors && conn.toAnchor !== undefined && to.face) {
      toEdge = { x: to.cx, y: to.cy }
    } else {
      toEdge = this.getEdgePoint(to.cx, to.cy, from.cx, from.cy, to.width, to.height)
    }
    if (Math.hypot(x - toEdge.x, y - toEdge.y) < threshold) {
      return { connId: conn.id, end: 'target' }
    }

    return null
  }

  private getCrosshairCursor(): string {
    const isDark = this.skin.appearance === 'dark'
    const fg = isDark ? '%23fff' : '%23000'
    const outline = isDark ? '%23000' : '%23fff'
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'><line x1='10' y1='0' x2='10' y2='20' stroke='${outline}' stroke-width='3'/><line x1='0' y1='10' x2='20' y2='10' stroke='${outline}' stroke-width='3'/><line x1='10' y1='0' x2='10' y2='20' stroke='${fg}' stroke-width='1.5'/><line x1='0' y1='10' x2='20' y2='10' stroke='${fg}' stroke-width='1.5'/></svg>`
    return `url("data:image/svg+xml,${svg}") 10 10, crosshair`
  }

  /** Hit-test a waypoint (bend) dot of the currently-selected connection. */
  private hitTestWaypointDot(x: number, y: number): { connId: string; index: number } | null {
    const singleConnId = this.getSingleSelectedConnectionId()
    if (!singleConnId) return null
    const conn = this.connectionMap.get(singleConnId)
    if (!conn) return null

    const waypoints = this.getEffectiveWaypoints(conn)
    if (waypoints.length === 0) return null

    const threshold = 10 / this.viewport.scale
    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i]
      if (Math.hypot(x - wp.x, y - wp.y) < threshold) {
        return { connId: conn.id, index: i }
      }
    }
    return null
  }

  // Build a uniform spatial grid over connection geometry bounds. Each connection
  // is inserted (by its index in this.connections) into every cell its bounding
  // box overlaps. Connections with no geometry are skipped — identical to the
  // `if (!geom) continue` in the scan they replace.
  private buildConnectionSpatialIndex(): SpatialGridIndex<number> {
    const index = new SpatialGridIndex<number>(CanvasEngine.CONN_GRID_CELL, 256)
    for (let i = 0; i < this.connections.length; i++) {
      const geom = this.getConnectionGeometry(this.connections[i])
      if (!geom) continue
      index.insert(geom.bounds, i)
    }
    return index
  }

  private getConnectionCandidateIndices(bounds: SpatialBounds): number[] {
    if (!this.connectionSpatialIndex) {
      this.connectionSpatialIndex = this.buildConnectionSpatialIndex()
    }
    return [...this.connectionSpatialIndex.query(bounds)].sort((a, b) => a - b)
  }

  private getVisibleConnections(padding = 0): Connection[] {
    const viewport = this.getViewportWorldBounds(padding)
    const visible: Connection[] = []
    for (const index of this.getConnectionCandidateIndices(viewport)) {
      const connection = this.connections[index]
      if (!connection || this.isConnectionHidden(connection)) continue
      const geometry = this.getConnectionGeometry(connection)
      if (geometry && this.boundsIntersect(geometry.bounds, viewport)) visible.push(connection)
    }
    return visible
  }

  private hitTestConnection(x: number, y: number): Connection | null {
    const threshold = 12 / this.viewport.scale

    if (!this.connectionSpatialIndex) {
      this.connectionSpatialIndex = this.buildConnectionSpatialIndex()
    }

    // Gather connections whose grid cells intersect the cursor's threshold box.
    // Because each connection is bucketed into every cell its bounds overlap, any
    // connection whose bounds intersect this box is guaranteed to appear here —
    // so this candidate set is a superset of the bbox-passing set, and the exact
    // bbox + distance test below yields the same result as scanning every
    // connection. (Candidates are visited in ascending index = original order, so
    // tie-breaking on equal distance also matches the full scan.)
    const candidateIndices = this.getConnectionCandidateIndices({
      x: x - threshold,
      y: y - threshold,
      width: threshold * 2,
      height: threshold * 2,
    })
    if (candidateIndices.length === 0) return null

    let closest: Connection | null = null
    let closestDist = threshold

    for (const i of candidateIndices) {
      const conn = this.connections[i]
      const geom = this.getConnectionGeometry(conn)
      if (!geom) continue

      // Quick bounding-box rejection
      if (
        x < geom.bounds.x - threshold ||
        x > geom.bounds.x + geom.bounds.width + threshold ||
        y < geom.bounds.y - threshold ||
        y > geom.bounds.y + geom.bounds.height + threshold
      ) {
        continue
      }

      const dist = this.pathPointDistance(geom, x, y)
      if (dist < closestDist) {
        closestDist = dist
        closest = conn
      }
    }
    return closest
  }

  private hitTestConnectionLabel(x: number, y: number): Connection | null {
    if (this.labelReach.x === 0) return null
    // A label's centre sits on its path (inside the geometry bounds) plus a
    // perpendicular offset clamped to ±40, and its box extends at most
    // `labelReach` around that centre — so only connections whose bounds lie
    // within `labelReach` of the cursor can be under it. Candidates come back in
    // ascending index order, the same first-match order as the full scan.
    for (const index of this.getConnectionCandidateIndices({
      x: x - this.labelReach.x,
      y: y - this.labelReach.y,
      width: this.labelReach.x * 2,
      height: this.labelReach.y * 2,
    })) {
      const conn = this.connections[index]
      if (!conn?.label) continue
      const bounds = this.getConnectionLabelBounds(conn.id)
      if (!bounds) continue
      if (x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height) {
        return conn
      }
    }
    return null
  }

  private bezierPointDistance(
    px: number, py: number,
    x0: number, y0: number,
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number
  ): number {
    let minDist = Infinity
    const steps = 50
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const a = 1 - t
      const a2 = a * a
      const a3 = a2 * a
      const t2 = t * t
      const t3 = t2 * t
      const bx = a3 * x0 + 3 * a2 * t * x1 + 3 * a * t2 * x2 + t3 * x3
      const by = a3 * y0 + 3 * a2 * t * y1 + 3 * a * t2 * y2 + t3 * y3
      const dx = px - bx
      const dy = py - by
      const dist = dx * dx + dy * dy
      if (dist < minDist) minDist = dist
    }
    return Math.sqrt(minDist)
  }

  private getEdgePoint(
    cx: number,
    cy: number,
    tx: number,
    ty: number,
    w: number,
    h: number
  ): { x: number; y: number; face: 'top' | 'bottom' | 'left' | 'right' } {
    const angle = Math.atan2(ty - cy, tx - cx)
    const hw = w / 2
    const hh = h / 2
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)

    const scaleX = Math.abs(hw / dx)
    const scaleY = Math.abs(hh / dy)
    const scale = Math.min(scaleX, scaleY)

    const ix = cx + dx * scale
    const iy = cy + dy * scale

    let face: 'top' | 'bottom' | 'left' | 'right'
    if (scaleX < scaleY) {
      face = dx > 0 ? 'right' : 'left'
    } else {
      face = dy > 0 ? 'bottom' : 'top'
    }

    const r = 8
    const left = cx - hw
    const right = cx + hw
    const top = cy - hh
    const bottom = cy + hh

    let arcCx = 0
    let arcCy = 0
    let checkQuarter: ((px: number, py: number) => boolean) | null = null

    if (face === 'top') {
      if (ix < left + r) {
        arcCx = left + r; arcCy = top + r
        checkQuarter = (px, py) => px <= arcCx && py <= arcCy
      } else if (ix > right - r) {
        arcCx = right - r; arcCy = top + r
        checkQuarter = (px, py) => px >= arcCx && py <= arcCy
      }
    } else if (face === 'bottom') {
      if (ix < left + r) {
        arcCx = left + r; arcCy = bottom - r
        checkQuarter = (px, py) => px <= arcCx && py >= arcCy
      } else if (ix > right - r) {
        arcCx = right - r; arcCy = bottom - r
        checkQuarter = (px, py) => px >= arcCx && py >= arcCy
      }
    } else if (face === 'left') {
      if (iy < top + r) {
        arcCx = left + r; arcCy = top + r
        checkQuarter = (px, py) => px <= arcCx && py <= arcCy
      } else if (iy > bottom - r) {
        arcCx = left + r; arcCy = bottom - r
        checkQuarter = (px, py) => px <= arcCx && py >= arcCy
      }
    } else if (face === 'right') {
      if (iy < top + r) {
        arcCx = right - r; arcCy = top + r
        checkQuarter = (px, py) => px >= arcCx && py <= arcCy
      } else if (iy > bottom - r) {
        arcCx = right - r; arcCy = bottom - r
        checkQuarter = (px, py) => px >= arcCx && py >= arcCy
      }
    }

    if (!checkQuarter) {
      return { x: ix, y: iy, face }
    }

    const ox = cx - arcCx
    const oy = cy - arcCy
    const b = 2 * (ox * dx + oy * dy)
    const cVal = ox * ox + oy * oy - r * r
    const discriminant = b * b - 4 * cVal

    if (discriminant < 0) {
      return { x: ix, y: iy, face }
    }

    const sqrtD = Math.sqrt(discriminant)
    const t1 = (-b + sqrtD) / 2
    const t2 = (-b - sqrtD) / 2

    const candidates = []
    if (t1 > 0) candidates.push({ x: cx + dx * t1, y: cy + dy * t1 })
    if (t2 > 0) candidates.push({ x: cx + dx * t2, y: cy + dy * t2 })

    for (const cand of candidates) {
      if (checkQuarter(cand.x, cand.y)) {
        return { x: cand.x, y: cand.y, face }
      }
    }

    return { x: ix, y: iy, face }
  }

  private findNearestAnchor(id: string, x: number, y: number, activeOnly = true): number | null {
    const obj = this.objects.find((o) => o.id === id)
    const indices = activeOnly ? this.getActiveAnchorIndices(id) : this.anchorDefs.map((_, i) => i)
    if (obj) {
      const cx = obj.position.x + obj.size.width / 2
      const cy = obj.position.y + obj.size.height / 2
      let bestIdx: number | null = null
      let bestDist = Infinity
      for (const i of indices) {
        const pt = this.getAnchorPoint(cx, cy, obj.size.width, obj.size.height, i)
        const dist = Math.hypot(x - pt.x, y - pt.y)
        if (dist < bestDist) {
          bestDist = dist
          bestIdx = i
        }
      }
      return bestIdx
    }
    const group = this.groups.find((g) => g.id === id)
    if (group) {
      const bounds = this.getGroupBounds(group)
      if (bounds) {
        const cx = bounds.x + bounds.width / 2
        const cy = bounds.y + bounds.height / 2
        let bestIdx: number | null = null
        let bestDist = Infinity
        for (const i of indices) {
          const pt = this.getAnchorPoint(cx, cy, bounds.width, bounds.height, i)
          const dist = Math.hypot(x - pt.x, y - pt.y)
          if (dist < bestDist) {
            bestDist = dist
            bestIdx = i
          }
        }
        return bestIdx
      }
    }
    return null
  }

  computeConnectionAnchors(
    connId: string,
    ends?: { from?: boolean; to?: boolean }
  ): { fromAnchor?: number; toAnchor?: number } | null {
    const conn = this.connections.find((c) => c.id === connId)
    if (!conn) return null

    const from = this.getConnectionEndpoint(conn.fromId, undefined)
    const to = this.getConnectionEndpoint(conn.toId, undefined)
    if (!from || !to) return null

    const fromEdge = this.getEdgePoint(from.cx, from.cy, to.cx, to.cy, from.width, from.height)
    const toEdge = this.getEdgePoint(to.cx, to.cy, from.cx, from.cy, to.width, to.height)

    const result: { fromAnchor?: number; toAnchor?: number } = {}
    if (ends?.from ?? conn.fromAnchor === undefined) {
      const idx = this.findNearestAnchor(conn.fromId, fromEdge.x, fromEdge.y, false)
      if (idx !== null) result.fromAnchor = idx
    }
    if (ends?.to ?? conn.toAnchor === undefined) {
      const idx = this.findNearestAnchor(conn.toId, toEdge.x, toEdge.y, false)
      if (idx !== null) result.toAnchor = idx
    }
    return result
  }

  private getBounds() {
    if (this.objects.length === 0) return { x: 0, y: 0, width: 800, height: 600 }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const obj of this.objects) {
      minX = Math.min(minX, obj.position.x)
      minY = Math.min(minY, obj.position.y)
      maxX = Math.max(maxX, obj.position.x + obj.size.width)
      maxY = Math.max(maxY, obj.position.y + obj.size.height)
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }
}
