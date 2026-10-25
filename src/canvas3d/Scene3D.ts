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
 * Scene3D — the native WebGL "blueprint board" (design: ui_kits/editor-3d).
 *
 * Everything is REAL scene content: extruded rounded card slabs whose walls are
 * shaded by a normal-mix shader (the kit's front/right wall colors), database
 * drums with the kit's cos-law face shading baked as vertex colors, raised
 * group platforms, a floating floor slab with a procedural dot-grid shader,
 * connections as flat ribbons on the board, and ALL text as GPU SDF (Inter /
 * JetBrains Mono — the design system's faces). No 2D-canvas rasterization of
 * shapes anywhere; the only bitmaps are icon glyphs and soft-shadow sprites.
 *
 * World frame: X = 2D world x, Z = 2D world y, Y = lift. Unlit materials with
 * kit-exact color mixes (sRGB output, no tone mapping) — a token hex renders as
 * that hex.
 *
 * Imperative engine like CanvasEngine: the host owns the canvas + data flow and
 * wires callbacks; rendering is on-demand (rAF only while something animates).
 */

import * as THREE from 'three'
import type { Text } from 'troika-three-text'
import type { C4Object, Connection, ConnectionHighlightStyle, Group, Position, Tag } from '../types'
import type { SkinConfig } from '../skins/types'
import { resolveConnectionAnimation, type ResolvedConnectionAnimation } from '../skins/connectionAnimation'
import {
  resolveGroupBottomBarColors,
  resolveObjectBottomBarColors,
  resolveStatusColor,
  resolveTagColor,
  resolveTeamColor,
  resolveTechnologyColor,
  type BottomBarTab,
} from '../canvas/bottomBarColors'
import {
  resolveConnectionPerspectiveTag,
  resolveHiddenTagState,
  resolvePinnedTagPresentation,
  resolveTagFocusMembership,
} from '../canvas/tagPerspective'
import {
  facetValues,
  objectFacetValues,
  resolveConnectionPerspectiveFacet,
  resolveFacetFocusMembership,
  resolveHiddenFacetState,
  resolvePinnedFacetPresentation,
  type ManagedPerspective,
} from '../canvas/facetPerspective'
import {
  CAMERA_PRESETS,
  CAMERA_TWEEN_MS,
  CONNECTION_LIFT,
  SELECTED_LIFT,
  type CameraPresetId,
} from './presets'
import { cableProfileFor, type CableProfile } from './cableProfile'
import {
  buildInkGeometry,
  createInkUniforms,
  headFit,
  inkCapGrowth,
  headShear,
  inkHeadOnDisc,
  inkHeadTriangle,
  inkRouteToHead,
  inkStartOnDisc,
  inkSetFor,
  inkStyle,
  INK_CORE_MAX_CSS,
  INK_CORE_MIN_CSS,
  INK_CORE_W,
  INK_DASH_MIN_CSS,
  INK_DASHED,
  INK_DOTTED,
  INK_HEAD_HALF_W,
  INK_HEAD_LEN,
  INK_PACKET,
  INK_SETS,
  inkBeadUniform,
  inkPacketFade,
  patchInkMaterial,
  screenDir,
  stripCasingWidthPx,
  stripCoreWidthPx,
  stripFacing,
  type InkDisc,
  type InkHead,
  type InkSetId,
  type InkStyle,
} from './inkLine'
import {
  buildHandleGeometry,
  createHandleMaterial,
  createHandleUniforms,
  discTriangleGap,
  easeOut,
  editHandleVisibility,
  handleHitRadius,
  handleStyle,
  HANDLE_D_HOT,
  HANDLE_HOVER_MS,
  setHandleAnchor,
  setHandleAppearance,
  type EditHandleKind,
} from './editHandle'
import { createGradientBackdrop, disposeGradientBackdrop, setBackdropTexture, type GradientBackdrop } from './backdrop'
import { ShadowDepthWarmer } from './lit/shadowWarm'
import type {
  Scene3dArrowhead,
  Scene3dCityMount,
  Scene3dConnLayer,
  Scene3dDecorInfo,
  Scene3dDisposeResidue,
  Scene3dPose,
  Scene3dProbe,
  Scene3dSceneStats,
  Scene3dSlowFrame,
} from './scene3dProbe'
import {
  applyPose,
  CameraRig,
  designEase,
  poseFor2dViewport,
  viewportForPose,
  type CameraPose,
  type CameraViewportInsets,
} from './camera'
import {
  cameraSide,
  labelAbbreviations,
  litLabelPlacement,
  onWireMaxDistance,
  onWireSpots,
  resolveScreenLabels,
  wireAnchor,
  type Box,
  type LabelShow,
  type Occluder,
  type ScreenLabel,
} from './connLabelPlacement'
import {
  colorAlpha,
  contrastRatio,
  drumFaceColor,
  ensureContrast,
  LIT_SMALL_INK_CONTRAST,
  mixColors,
  nodeWallColors,
  readableOn,
  resolve3dPalette,
  techColor,
  withAlpha,
  type Palette3d,
} from './palette'
import { disposeIconTextures, iconTexture, techIconTexture } from './icons'
import { orderedTechnologyUsages } from '../lib/technologyUsage'
import { objectShortDescription } from '../lib/objectDescription'
import { objectTypeBadgeLabel } from '../lib/objectTypeBadge'
import i18n from '../lib/i18n'
import {
  DESCRIPTION_TO_TYPE_BADGE_GAP,
  centeredObjectContentTop,
  fitObjectDescription,
  objectContentLayout,
} from '../canvas/objectContentLayout'
import {
  calculateSmartGuides,
  type GuideRect,
  type SmartGuide,
} from '../lib/layout/alignmentGuides'
import { makeText, preloadFonts } from './text'
import {
  BoxGrid,
  exceptSource,
  freeScale,
  INTER_CAP_EM,
  legibleScale,
  type ObstacleSource,
  overlapsAny,
  roomiestSpot,
  scaleAbout,
  settleScales,
  unionSource,
} from './labelLegibility'
import { convexGap, convexHull, convexOverlap, plaqueInFront, screenShadowOnFloor, slideClear } from './screenClearance'
import {
  ANCHOR_COUNT,
  anchorPoint,
  connectionPath,
  endpointDragPreview,
  nearestAnchorIndex,
  nearestSegmentIndex,
  nearestTOnPath,
  pathPoint,
  pathTangent,
  samplePath,
  type PathGeometry,
  type Rect,
} from './connectionPath'
import type { Environment3D, FloorSpec3D, NodeSpec3D, Theme3dSource } from './specs'
import type { SceneDecor3D } from './decor/decorSpec'
import { CITY_HOLE_APRON, placeDecor, type PlacementInput, type ShowcaseView } from './decor/placement'
import { DESK_ARCHETYPES, getDecorPack } from './decor/registry'
import { buildDecorMeshes, disposeDecorGeometries, type DecorBuildResult } from './decor/build'
import { decorAsset, loadDecorAssets, releaseDecorAssetGpu } from './decor/glbAssets'
import {
  acquireRoomEnvironmentAsync,
  disposeLightRig,
  fitShadowCamera,
  mountLightRig,
  releaseRoomEnvironment,
  type LightRig,
} from './lit/lighting'
import { litSurface } from './lit/materials'
import type { PostStack, QualityTier } from './lit/post'
import { compileAndWait } from './lit/compileSafe'
import { paperBoardTextures } from './lit/paper'
import { TRAY_BASE_CSS, trayTexturesFor, type TrayVariant } from './lit/boards'
import {
  CITY_DESK_BASE,
  CITY_DESK_CONTRAST,
  CITY_DESK_RELIEF,
  WOOD_DESK_RELIEF,
  deskBoardsGeometry,
  deskVignetteTexture,
  disposeWorkbenchTextures,
  workbenchTextures,
} from './lit/wood'
import { CUT_MAT_LIFT, cuttingMatGeometry, cuttingMatTextures, disposeCuttingMatTextures } from './lit/cuttingMat'
import {
  assembleCityBackground,
  buildCityGeometrySliced,
  buildCityPodium,
  buildDeskLamp,
  buildStudioBackground,
  cityMaterial,
  CITY_PODIUM_H,
  DESK_LAMP_FOOT_R,
  DESK_LAMP_SHADE_R,
  DESK_LAMP_SHADE_REACH,
  disposeCityGeometry,
  type CityGeometry,
  type CityGeometryOpts,
  type MakeMat,
} from './decor/backgrounds'
import { disposeCityFacadeTextures } from './decor/cityFacade'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { disposeThemeAssets, getLoadedAsset, loadThemeAsset } from './assets'
import { getActiveScene3D, setActiveScene3D } from './activeScene'
import { groupDragMoves, groupPlatformRect, startGroupDrag, type GroupDragStart } from './groupPlatform'

// ── DS card anatomy (design-system C4 node card / editor-3d kit) ─────────────
const CARD_RADIUS = 14
const CARD_PAD_X = 15
const CARD_PAD_Y = 13
const NAME_SIZE = 13
const SUB_SIZE = 10.5
/** Lit-profile connection label (text px / plate height) — see buildConnections. */
const CONN_LABEL_SIZE_LIT = 13
const CONN_LABEL_PLATE_H_LIT = 21
const PILL_SIZE = 10
const PILL_H = 16
const PILL_RADIUS = 6
// standee drum (kit CylStandee)
const DRUM_R = 46
const DRUM_H = 64
/** Lit connection label plates draw in the transparent pass after every card
 * and tag decal/text (renderOrder 0), and under the flow packets (40+); their
 * text is +1. */
const CONN_LABEL_PLATE_ORDER = 30
/** Lit ink lines (inkLine.ts) draw in the transparent pass between the card
 * decals (0) and the label plates: each connection's casing, then its core,
 * in [INK_ORDER_BASE, INK_ORDER_BASE + INK_ORDER_SPAN) — a later line's halo
 * cuts a clean gap through an earlier line's ink where they cross. What the
 * connection layer draws OVER the lines (flow effects, edit chrome) is lifted
 * to INK_ORDER_OVER. */
const INK_ORDER_BASE = 1
const INK_ORDER_SPAN = 20
const INK_ORDER_OVER = 22
/** A lit ink line picks within this many css px of its projected centreline
 * (inkLineAt) — the design spec's "a click within 4 css px of a line's
 * centre selects it", with a pixel of rounding. */
const INK_PICK_PX = 5
const PAD_R = 59

/** Kit text-width heuristic (Editor3DApp uses `len * 6.2 + 14` at 10.5px). */
const approxTextWidth = (text: string, fontSize: number) => text.length * fontSize * 0.59

/** The floor tag in front of a drum (buildStandee, kit ed3c3__tag): the
 * datastore NAME, Inter 600 at SUB_SIZE — the base design (edfc9c6f7).
 * Quality loop 4 moved the name onto the drum's face in big bold text and
 * left the tag the technology; the user rejected that on 2026-10-10 ("sur
 * les shapes je vois des régressions sur la police et la taille de la police
 * et l'icône par rapport à avant") and the base typography is restored. */
function storeTagText(o: C4Object): string {
  return o.name
}

/** The floor tag's width (text + 18, kit — drawn even for an empty name,
 * as the base did). */
function storeTagW(o: C4Object): number {
  return approxTextWidth(storeTagText(o), SUB_SIZE) + 18
}

/** The floor tag's height (kit). */
const STORE_TAG_H = 18

/**
 * The floor tag's board rect (top-left + size), or null without a tag.
 *
 * Quality pass "labels" round 2 (tp2-final-dpr1/workbench-labels.png x
 * 415-500 y 700-760 and x 690-760 y 880-940): the tag sat at a fixed +z
 * (cz + 49 .. 67) whatever the camera azimuth — at the iso preset (rz 45)
 * that is BESIDE the drum, its inner end on the pad ring under the drum's
 * foot ('PostgreSQL') and its outer end run off under the bottom chrome
 * ('Elasticsearch'). It now stands on the CAMERA side — its centre on the
 * board ray from the drum centre toward the preset camera — with every
 * corner past the drum's front tangent line by STORE_TAG_GAP: a plaque in
 * front of the exhibit, no part of it beside or behind the drum (a flat point
 * in front of a standing cylinder is never hidden by it). Every consumer
 * (the standee, the fit box, the label occluders and obstacles, the decor
 * footprint, the probe's solids) reads this one rect.
 */
const STORE_TAG_GAP = 6
function storeTagRect(o: C4Object, r: Rect, azimuthDeg: number, drumR: number): Box | null {
  const w = storeTagW(o)
  if (!(w > 0)) return null
  return plaqueInFront(r.x + r.w / 2, r.y + r.h / 2, w, STORE_TAG_H, azimuthDeg, drumR, STORE_TAG_GAP)
}

// ── Projected-size LOD (plan §0/§3 — the draw-call/text mitigation at scale) ──
// A node's readable decorations hide once its on-screen width shrinks past
// readability, so a fit-all of hundreds of nodes doesn't pay for sub-pixel text
// and tiles nobody can read. Decorations tag themselves via `userData.lod`; the
// pickable fill plate, slab and shadow are NEVER tagged (they define the card).
const LOD_SECONDARY = 1 // subtitle, tech pills, accent bar — first to hide
const LOD_PRIMARY = 2 // name, type tile, glyph, icon — kept until very small
// (No far-title tier and no badge growth/hiding: view3d quality loop 3 r2
// swapped every card's face for a big Inter 700 title at wide framings and
// hid the tech badges under a readable size; the user rejected both on
// 2026-10-10 — the card and drum faces are the base design at every
// framing, and only this projected-size LOD hides them, as in edfc9c6f7.)
/** The desk lamp's bearing on the workbench (plan unit vector from its foot,
 * world x/z) and how far along it the light lands (world px): the shade
 * hangs BEHIND the foot, away from the slab, and pours back down onto the
 * desk around the lamp's own base — toward the camera, so the pool and the
 * lit inside of the dome both face the default iso view.
 *
 * Measured with .probes/lamp (each aim a live probe, 2026-10-10): any shade
 * hung over the slab lit the board (the critic's disc and hot spot); a shade
 * over the desk looking straight down hid its own pool from the iso camera
 * (the dome covers ~80 units of desk behind it, the raised board ~36 in
 * front of its edge) — at −x 85 / −z 20 the visible pool was a 35 × 16 px
 * sliver, Δ ≤ 11 luminance; at −x 140 / −z 50 the back of the dome faced
 * the camera like a dish. Up-screen is about (−0.58, −0.81) here. */
const LAMP_BEARING: readonly [number, number] = [-0.6, -0.8]
const LAMP_AIM_DIST = 40
/** A lit connection label grows at most this much (labelLegibility.ts). */
const CONN_LABEL_MAX_GROW = 2.2
/** A sliced label placement pass runs at most about this long per task
 * (runLabelJob) — far under the 50-ms long-task line, so input and frames
 * run between slices. */
const LABEL_SLICE_MS = 8
/** …and the first slice of a FULL rebuild's pass (runLabelJob `inline`):
 * room for a small board's whole pass (25-29 ms on the 9-node test board,
 * me-tp4 labelPerf) so its decor is built around the placed plates. */
const LABEL_INLINE_MS = 60
/** Screen gap (css px) a lit label plate keeps from every card and drum at
 * the default framing (quality pass "labels": 'evaluates' read as tucked
 * under Alert manager at a 0.4 px overlap). The margin absorbs the build's
 * fit pose against the live one: they agreed within 0.2 px on one probe,
 * but a harness run (tp2-labels, first pass, margin 1.5) built 'queries'
 * >= 1.5 px clear and measured it 0.8 px live, edge to edge with
 * 'searches'. At 2.5, 'reads' and 'consumes' (1.9-2.3 px) shrink in place
 * to x1.94 / x1.89 (11.9 / 8.7 px caps). */
const LABEL_SCREEN_GAP_PX = 2.5
/** A label slid off a card on screen must still read: its projected cap
 * height at the default framing (the harness gate holds 8 px; the estimate
 * is the view-centre scale, measured 2 % over the true cap on the harness
 * board — 'evaluates' 9.2 estimated, 9.0 measured — so 0.5 px of margin). */
const LABEL_SCREEN_MIN_CAP_PX = 8.5
const LOD_SECONDARY_PX = 140 // card projected width (css px) below which tier-1 hides
const LOD_PRIMARY_PX = 84 // …below which tier-2 hides too (a bare colored slab)

// Showcase mode (viewer/embeds): slow presentation auto-orbit — a full
// turn every 60s — pausing on any interaction and resuming after a beat.
const SHOWCASE_DEG_PER_S = 6
const SHOWCASE_RESUME_MS = 2500
/** Longest the render loop waits on an async shader compile (scheduleCompile). */
const COMPILE_GATE_MAX_MS = 4000
/** Longest the decor layer waits for its Blender GLBs before building the procedural fallback. */
const DECOR_ASSET_WAIT_MS = 1500
/** Governor: frame-pacing EMA above this (ms) counts as a slow frame (~38 fps)… */
const GOVERNOR_SLOW_MS = 26
/** …and this many consecutive slow frames steps quality down once. */
const GOVERNOR_SLOW_FRAMES = 60

export interface Scene3DCallbacks {
  onObjectSelect: (id: string | null, multi: boolean) => void
  onGroupSelect: (id: string | null) => void
  onConnectionSelect: (id: string | null) => void
  onObjectMove: (id: string, position: { x: number; y: number }) => void
  onGroupMove: (id: string, position: { x: number; y: number }) => void
  /** Connection editing (2D-engine parity). The host wires these to the same
   * store actions as the 2D canvas — in 3D view mode the store lands routing
   * fields on the *3d twins, so 2D routing is never touched from here. */
  onConnectionAnchorMove?: (connId: string, end: 'source' | 'target', targetId: string, anchorIndex: number) => void
  onConnectionWaypointsChange?: (connId: string, waypoints: Position[]) => void
  onConnectionLabelMove?: (connId: string, position: number, offset: number) => void
  /** Fired once when a drag gesture ends (hosts checkpoint undo/sync here). */
  onDragEnd?: () => void
  /** Double-click on an object. When provided it REPLACES the default
   * zoom-toward-the-node tween — the Model Viewer drives its drill-down
   * choreography (flyTo → data swap → arriveFrom) from this. */
  onObjectOpen?: (id: string) => void
}

interface SceneData {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  /** Tag registry — bottom-bar "color by tags" resolution. */
  tags: Tag[]
}

type PickTarget =
  | { kind: 'object'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'connection'; id: string }
  | { kind: 'connEndpoint'; id: string; end: 'source' | 'target' }
  | { kind: 'connWaypoint'; id: string; index: number }
  | { kind: 'connLabel'; id: string }
  | { kind: 'expand'; id: string }
  | { kind: 'voxel'; id: string }

interface VoxelFragment {
  id: string
  index: number
  size: number
  dimensions: THREE.Vector3
  home: THREE.Vector3
  position: THREE.Vector3
  rotationY: number
  outward: THREE.Vector2
}

interface VoxelAnimation {
  from: THREE.Vector3
  to: THREE.Vector3
  fromRotation: number
  toRotation: number
  hop: number
  start: number
  duration: number
}

/** One highlighted connection's focus animation (the 2D
 * renderConnectionHighlightEffect, translated to the board — each style is a
 * real port of its flat algorithm, see buildFlowEffect). Meshes live in
 * connLayer — disposed with it on every routing refresh; `tick` mutates only
 * transforms, buffer attributes, opacities and shader uniforms. */
interface FlowUnit {
  kind: ConnectionHighlightStyle
  geom: PathGeometry
  /** Advance the animation to `now` (rAF timestamp). */
  tick: (now: number) => void
  /** traveling-dot / energy-beam: the traveling packet (probe handle). */
  dot?: THREE.Object3D
  /** A lit ink line's bead (painted in its core, no mesh of its own): where
   * its centre is (layer-local plan), for the probe. */
  pos?: { x: number; z: number }
  /** …its line, the fade uniforms of the meshes that paint it, and the fade
   * and on-screen clearance (css px) it was last drawn with. */
  bead?: { connId: string; ks: THREE.IUniform<number>[]; fade: number; clearPx: number }
  /** Normalized animation phase last rendered (dev probe: e2e asserts
   * PROGRESS on the phase — world distance depends on path length/pacing). */
  lastT?: number
}

/** A flat stroke on the board whose centerline, per-point half-width and
 * draw range are rewritten every frame — the scene-side equivalent of the 2D
 * engine re-stroking a displaced polyline (strands / electric / lightning). */
interface DynamicStroke {
  mesh: THREE.Mesh
  uColor: THREE.IUniform<THREE.Color>
  uAlpha: THREE.IUniform<number>
  /** `fn` fills world x/z + half-width for sample i (t = i/samples); pass
   * `active` < samples to collapse the tail (growing bolt). */
  update(fn: (i: number, t: number, out: { x: number; z: number; hw: number }) => void, active?: number): void
}

/** Kinds a dragged connection endpoint may be dropped on. */
const CONN_DROP_KINDS: ReadonlySet<PickTarget['kind']> = new Set(['object', 'group'])
const CONN_PICK_KINDS: ReadonlySet<PickTarget['kind']> = new Set([
  'connection',
  'connEndpoint',
  'connWaypoint',
  'connLabel',
])

/** Semantic material roles for the profile-aware `surface()` seam (PBR
 * migration). One role per visual duty — the lit family maps each to its
 * physical recipe; the unlit family ignores it. */
type SurfaceRole =
  | 'cardCap'
  | 'cardFill'
  | 'chrome'
  | 'glow'
  | 'floorRing'
  | 'platform'
  | 'platformRing'
  | 'pad'
  | 'padRing'
  | 'drum'
  | 'drumBand'
  | 'drumLid'
  | 'tagPlate'
  | 'ribbon'
  | 'connInk'
  | 'connLabel'
  | 'handle'
  | 'selectionRing'
  | 'accentBar'

export class Scene3D {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private rig: CameraRig
  private root = new THREE.Group()
  private connLayer = new THREE.Group()
  private smartGuideLayer = new THREE.Group()
  private raycaster = new THREE.Raycaster()

  private data: SceneData = { objects: [], connections: [], groups: [], tags: [] }
  /** The object ids of `data.objects`, rebuilt when that array is replaced (groupRect). */
  private objectIdsOf: { objects: SceneData['objects']; ids: Set<string> } | null = null
  private skin: SkinConfig | null = null
  private resolvedTheme: 'light' | 'dark' = 'light'
  private palette: Palette3d | null = null
  private preset: CameraPresetId = 'iso'
  private selectedIds = new Set<string>()
  private readonly_ = false
  /** Objects that get the corner expand glyph (Model Viewer drill affordance);
   * supplied per setData by the viewer host — the editor never sets any. */
  private expandableIds = new Set<string>()
  /** Projected-size LOD cut-offs (css px). Hosts may lower them — the Model
   * Viewer keeps names readable further out than the editor's defaults. */
  private lodPrimaryPx = LOD_PRIMARY_PX
  private lodSecondaryPx = LOD_SECONDARY_PX
  /** Focus-animation style + master toggle — per-diagram settings, same values
   * the 2D engine receives (CanvasView/ViewerCanvas push both to both views). */
  private highlightStyle: ConnectionHighlightStyle = 'traveling-dot'
  private connAnimationsEnabled = true
  /** BottomBar "color by" tab (uiStore.bottomTab) — drives the accent bar. */
  private bottomTab: BottomBarTab = null
  private activeTagGroupId: string | null = null
  private hoveredTagId: string | null = null
  private pinnedTagIds: string[] = []
  private focusedTagId: string | null = null
  private hiddenTagIds = new Set<string>()
  private managedPerspectiveInteractions: Record<ManagedPerspective, {
    hoveredId: string | null
    pinnedIds: string[]
    focusedId: string | null
    hiddenIds: Set<string>
  }> = {
    technology: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: new Set() },
    status: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: new Set() },
    teams: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: new Set() },
  }
  private tagFocusResolved = true
  private tagFocusObjectIds = new Set<string>()
  private tagConnectedObjectIds = new Set<string>()
  /** The 2D canvas's grid toggle (uiStore.showGrid) — visual only, snapping
   * stays active, exactly like the flat engine. */
  private showGrid = true
  /** Live handle on the floor shader's dot color so the toggle needs no
   * rebuild: on = the resolved grid color, off = the floor bg (dots vanish). */
  private floorGridToggle: { uniform: THREE.IUniform<THREE.Color>; on: THREE.Color; off: THREE.Color } | null = null
  /** Lit-profile grid toggle: the paper board swaps textures instead of a
   * shader uniform (on/off variants share the palette-keyed cache). */
  /** The lit cap's map-only grid toggle: `on` at rest, `drag` (the full
   * pitch, minors included — trays only; paper has one look) while a card
   * or a group is dragged, `off` when the grid is hidden. */
  private litFloorGrid: { mat: THREE.MeshPhysicalMaterial; on: THREE.Texture; off: THREE.Texture; drag: THREE.Texture } | null = null
  /** A card or a group is being dragged (litFloorGrid shows the minors). */
  private gridDragging = false
  /** Live focus animations, one per highlighted connection (rebuilt with the
   * connections; empty whenever nothing is selected → idle rAF stays 0). */
  private flowUnits: FlowUnit[] = []

  private nodeGroups = new Map<string, THREE.Group>()
  private groupPlates = new Map<string, THREE.Group>()
  private pickables: THREE.Object3D[] = []
  private buildSignature = ''
  private texts: Text[] = []
  /** Connection labels rebuild on every routing refresh (drags) — own bucket
   * so their SDF resources are disposed per refresh, not per full rebuild. */
  private connTexts: Text[] = []
  private smartGuideTexts: Text[] = []
  private smartGuideCandidates: GuideRect[] = []
  private smartGuides: SmartGuide[] = []
  private smartGuideSnap = { x: false, y: false }
  /** Per-axis snap decision of the LAST drop: a guide-captured axis keeps the
   * guide-aligned coordinate, the free axis clips to the half-grid. Stamped at
   * pointerup (smartGuideSnap itself is cleared right after the dispatch), so
   * the dev probe can assert the drop contract honestly. */
  private lastDropGuideSnap = { x: false, y: false }
  /** Routing geometry from the last buildConnections — edit-gesture math reads it. */
  private connGeoms = new Map<string, PathGeometry>()
  /** Arc position + normal offset each lit label was actually drawn at (it
   * may have slid along its wire, or nudged across it) — the label-slide
   * gesture starts from it, so grabbing a label does not snap it back to its
   * stored spot. */
  private connLabelOffsets = new Map<string, { t: number; offset: number }>()
  /** Board boxes of the lit label plates from the last buildConnections —
   * decor placement keeps its props off them. */
  private connLabelBoxes: Box[] = []
  /** Debug/perf: how the last buildConnections grew its labels (probe). */
  private connLabelGrowth: { kWant: number; labels: { connId: string; kFree: number; moved: boolean }[] } = { kWant: 1, labels: [] }
  /** The desk lamp's plan footprint on the workbench (world x/z + radius):
   * one circle over its foot, the desk under its shade and its pool — desk
   * props keep off it and the greenery zone gathers beside it (placement.ts
   * `lamp`). Null without a lamp. */
  private lampFoot: { x: number; z: number; r: number } | null = null
  /** The last built slab (world x/z of its top-left corner, size, top and
   * desk heights) — dev probe only (boardInfo). */
  private boardBox: { x: number; z: number; w: number; h: number; topY: number; deskY: number } | null = null
  /** The last `placeDecor` input, archetypes as ids — dev probe only
   * (decorPlacementInput): the quality harness replays the live desk layout
   * through the pure function offline. */
  private lastDecorInput: (Omit<PlacementInput, 'archetypes'> & { archetypes: string[] }) | null = null
  /** The label boxes the current decor was placed around (labelBoxesSig). */
  private decorAvoidSig = ''
  /** Lit connection labels that grow at far framings (labelLegibility.ts):
   * the plate + text, the label's box at its own size (centre + extent), the
   * point it grows away from, the room it has (kFree) and its current k. */
  private connLabelScalers: {
    plate: THREE.Mesh
    text: Text
    cx: number
    cz: number
    w: number
    h: number
    anchor: { x: number; y: number }
    kFree: number
    k: number
    /** The connection it labels (connLabelOffsets key). */
    connId: string
    /** Its entry in connLabelBoxes (the decor keeps off it). */
    boxIndex: number
    /** Arc position + signed normal offset it sits at. */
    t: number
    offset: number
    /** The arc position it prefers (stored, else the midpoint) and the side
     * a cross-wire nudge tries first — onWireSpots' ordering. */
    tPref: number
    side: number
    /** Path point + unit tangent at an arc position (its own wire). */
    sample: (t: number) => { pt: { x: number; y: number }; tan: { x: number; y: number } }
    /** Where the plate lands (centre + lift) at (t, offset), wire clearance
     * enforced — litLabelPlacement in its follow-the-pointer mode. */
    placeAt: (t: number, offset: number) => { x: number; y: number; lift: number; t: number; offset: number }
    cableR: number
    /** The connection's whole label, and what it shows at the current
     * framing (resolveConnLabelVisibility: whole, abbreviated or hidden). */
    fullText: string
    shown: LabelShow
    /** The plate geometry of the whole label (w wide); an abbreviated plate
     * wears a narrower one centred in it until the label shows whole again. */
    fullGeo: THREE.BufferGeometry
    plateR: number
    /** Where it may be drawn at any framing: spot 0 is where buildConnections
     * placed it, the rest are the spots ON its wire (onWireSpots, preference
     * order) clear of the other wires on the board — the settle pass takes
     * the first one with room on screen. Empty until the build fills it. */
    spots: { x: number; z: number; lift: number; t: number; offset: number; anchor: { x: number; y: number } }[]
    /** The lift its home spot (cx, cz) floats at — the placement pass's
     * state; the plate mesh shows it only once the pass commits. */
    lift: number
    /** Its own placement inputs (text, preferred spot, wire, cable radius):
     * a rebuild that leaves them alone keeps showing what the label showed
     * until the new placement pass commits (runLabelJob). */
    sig: string
  }[] = []
  /** The running lit-label placement pass (connLabelLayout), sliced off the
   * build that started it; null when none is pending. */
  private labelJob: {
    gen: Generator<void, void, void>
    t0: number
    cpuMs: number
    slices: number
    maxSliceMs: number
  } | null = null
  /** True from the start of a placement pass until it commits: the label
   * meshes show the previous framing's result (or where the build put them)
   * and the settle-time scale / resolve leave them alone. */
  private labelHold = false
  /** The slice scheduler of the placement pass (a MessageChannel task: no
   * 4-ms timer clamp between slices, and input still runs between them). */
  private labelChannel: MessageChannel | null = null
  private labelSliceFn: (() => void) | null = null
  /** The uniforms every lit ink material shares (inkLine.ts): the canvas
   * height in css px and the world px per css px at the orbit target —
   * refreshed before each frame (updateInkUniforms). */
  private inkUniforms = createInkUniforms()
  /** The lit edit handles of the single selected connection (editHandle.ts):
   * one billboard geometry (front + x-ray meshes share it), the handles in
   * its vertex order — the target knob is re-placed every frame
   * (updateEditHandles), since its world spot depends on the camera. */
  private editChrome: {
    connId: string
    geo: THREE.BufferGeometry
    items: {
      role: 'source' | 'knob' | 'bend' | 'drag' | 'anchor'
      kind: EditHandleKind
      id: number
      x: number
      y: number
      z: number
      visible: boolean
      pick: PickTarget | null
    }[]
    /** The knob's spot is behind its own target shape (it hides). */
    knobOccluded?: boolean
  } | null = null
  private handleUniforms = createHandleUniforms()
  /** The selected line's halo material and its resting opacity (a hovered
   * head / knob brightens it). */
  private selectHalo: { mat: THREE.Material; base: number } | null = null
  /** The hovered handle (its glow + growth run HANDLE_HOVER_MS from `start`). */
  private handleHover: { id: number; start: number } | null = null
  /** Cost of the lit label passes (probe connLabelPerf, TASK 2): the last
   * build's placement pass (growth, screen pass, spot lists) and the
   * settle-time resolve (last, worst, count). */
  private connLabelPerf = {
    buildMs: 0,
    resolveMs: 0,
    resolveMaxMs: 0,
    resolves: 0,
    connBuildMs: 0,
    connBuildMaxMs: 0,
    connBuilds: 0,
    jobSlices: 0,
    jobMaxSliceMs: 0,
    jobWallMs: 0,
    jobsCancelled: 0,
  }
  /** The connection the pointer rests on (its label shows whole). */
  private connLabelHoverId: string | null = null
  /** Text-bearing features on each card's top face (the type chip, the
   * title), CARD-LOCAL — recorded by buildCard, translated by the card's
   * position in buildConnections, where lit label plates keep off them. */
  private cardTextRects = new Map<string, Box[]>()
  /** Host-measured overlay insets (css px) for fit-to-screen — see
   * setSafeAreaProvider. */
  private safeAreaProvider: (() => CameraViewportInsets) | null = null
  /** The insets the last fit-to-screen framed inside (see frame()). */
  private lastFitInsets: { left: number; right: number; top: number; bottom: number } | null = null
  /** batch(): nesting depth, and whether a rebuild was requested inside it. */
  private batchDepth = 0
  private batchDirty = false
  /** Each connection's centreline as built (the ribbon's samples,
   * layer-local x / height / z) — the connLabelWireInfo probe measures every
   * label plate against its OWN wire with it, the arrow probe samples the
   * line's contrast along it. */
  private connLines = new Map<string, { x: number; y: number; z: number }[]>()
  /** Every connection's flat arrowhead as the last connection build drew it
   * (arrowheadInfo probe; the label passes keep off the lit ones): its tip
   * and axis (layer-local), the target's rect, the 2D stroke and — lit — the
   * ink style it wears (inkLine.ts). Unlit ribbons keep Clean's 14 × ±5
   * triangle (`ink` null). */
  private arrowDebug: {
    connId: string
    toId: string
    kind: 'flat'
    head: InkHead
    length: number
    halfW: number
    target: Rect
    /** The lit line's dash pattern (world px), null when solid. */
    dash: readonly [number, number] | null
    highlighted: boolean
    alpha: number
    strokeCss: string
    ink: InkStyle | null
  }[] = []

  /** The floor dressing (slab, grid, border, ground shadow) fades with the
   * 2D↔3D morph: 0 = the flat 2D reading, 1 = the dressed board. The
   * material list is (re)registered by buildFloor on every rebuild; base*
   * capture the material's resting blend/depth state so applyFloorAlpha can
   * restore it once the fade lands (see the layering invariant there). */
  private floorFade: {
    mat: THREE.Material
    base: number
    uniform?: THREE.IUniform<number>
    baseTransparent: boolean
    baseDepthWrite: boolean
  }[] = []
  private floorAlpha = 1
  private floorTween: { from: number; to: number; start: number; duration: number } | null = null
  /** The pose the last enter morph started from (dev probe: e2e asserts the
   * framing identity deterministically instead of racing the tween). */
  private lastEnterStart: ReturnType<CameraRig['getPose']> | null = null

  /** Theme 3D surface: sanitized spec builders + environment +
   * pixel-snap, resolved OUTSIDE the chunk (plugins/theme3d.ts). */
  private theme3d: Theme3dSource | null = null
  private env3d: Environment3D | null = null
  /** Micro-animation registry (spec spin/bob) — transform-only ticking, no
   * rebuilds. Empty for the default theme, so the idle-rAF-0 bar holds. */
  private motionUnits: {
    obj: THREE.Object3D
    bob?: { amp: number; speed: number; phase: number }
    spinObj?: THREE.Object3D
    spinSpeed?: number
  }[] = []
  /** Camera-facing theme-asset planes (NodeSpec3D geometry 'billboard') —
   * re-oriented before every render, so orbiting keeps them front-on. */
  private billboards: THREE.Mesh[] = []
  /** Whether the current floor carries a theme floorTexture (probe). */
  private floorTextured = false
  /** Raw-sRGB clone of the theme floorTexture (the custom floor shader needs
   * authored values back from the sampler, not a hardware sRGB decode). */
  private floorMapClone: { src: THREE.Texture; clone: THREE.Texture } | null = null
  /** Eight-bit breakaway blocks stay in one InstancedMesh. Their offsets live
   * only in this Scene3D instance, so rebuilds preserve play while reloads reset. */
  private voxelScatter: {
    mesh: THREE.InstancedMesh
    floor: THREE.Group
    fragments: Map<string, VoxelFragment>
    interactive: boolean
  } | null = null
  private voxelTransient = new Map<string, { dx: number; dz: number; rotationY: number }>()
  private voxelAnimations = new Map<string, VoxelAnimation>()
  private hoveredVoxelId: string | null = null
  private readonly voxelMatrix = new THREE.Matrix4()
  private readonly voxelQuaternion = new THREE.Quaternion()
  private readonly voxelScale = new THREE.Vector3()
  private readonly voxelUp = new THREE.Vector3(0, 1, 0)

  /** In-flight connection-edit gesture (single selected connection): endpoint
   * re-anchor, bend insert/move, label slide — the 2D engine's gestures. */
  private connEdit:
    | { mode: 'endpoint'; connId: string; end: 'source' | 'target'; preview: Position | null; hoverShapeId: string | null }
    | { mode: 'waypoint'; connId: string; index: number; working: Position[] }
    | { mode: 'pending'; connId: string; index: number; start: Position }
    | { mode: 'label'; connId: string; t: number; offset: number }
    | null = null

  private raf = 0
  private needsRender = false
  /** A shadow caster may have changed since the shadow map was last drawn. */
  private shadowsDirty = true
  private disposed = false
  private devProbeIdentity: unknown = null
  /** GL context resilience: render loop pauses while the context is
   * lost; the restore handler forces a full cache-backed rebuild so every
   * geometry/texture/SDF re-uploads into the fresh context. `contextRestores`
   * counts recoveries (dev probe — the e2e drill asserts the handler ran). */
  private contextLost = false
  private contextRestores = 0
  /** Showcase auto-orbit: drifts azimuth while nothing else claims the
   * camera; any gesture holds it (hold window pushed forward each held frame)
   * and a one-shot timer re-kicks the loop once the hold expires — so a
   * paused showcase costs zero rAF, same as idle. */
  private showcase = false
  private showcaseHoldUntil = 0
  private showcaseResumeTimer: number | null = null
  private showcaseLastNow = 0
  // Projected-size LOD: recomputed when the camera settles (tracked here) or
  // after builds/resizes; `_lodSize` is a reused scratch for renderer.getSize.
  private wasAnimating = false
  private _lodSize = new THREE.Vector2()

  // pointer state
  private pointer: {
    mode: 'idle' | 'orbit' | 'pan' | 'dragNode' | 'dragGroup' | 'dragVoxel' | 'connEdit'
    id: string | null
    lastX: number
    lastY: number
    grabDX: number
    grabDZ: number
    moved: boolean
    button: number
    /** Last world position a node/group drag dispatched (drop-snap input). */
    lastPos: { x: number; y: number } | null
    /** Group-drag capture (2D parity: members ride along by the drag delta). */
    groupDrag: GroupDragStart | null
  } = { mode: 'idle', id: null, lastX: 0, lastY: 0, grabDX: 0, grabDZ: 0, moved: false, button: 0, lastPos: null, groupDrag: null }

  private detachFns: (() => void)[] = []

  // ── render-profile surface (PBR theme-by-theme migration) ──────────────────
  // 'unlit' is the historical pipeline: MeshBasicMaterial + raw-sRGB shaders,
  // no GPU lights, NoToneMapping. Themes migrate individually by declaring an
  // `environment.lighting` block; until a lit theme is active these hold their
  // unlit values, and `sceneStats()` is the e2e contract for that (the pinned
  // unlit suites assert profile 'unlit' / 0 lights / no shadow map / no IBL).
  private renderProfile: 'unlit' | 'lit' = 'unlit'
  /** Post/quality tier — 'high' until the lit post stack lands and a theme
   * (or the auto-degrade governor) moves it. */
  private qualityTier: 'high' | 'medium' | 'low' = 'high'
  /** Active composer pass count (0 = composer-less direct render). */
  private composerPassCount = 0
  /** The lit profile's fixed light rig (null while unlit). */
  private litRig: LightRig | null = null
  /** Whether this scene holds a ref on the shared PMREM room environment. */
  private litEnvHeld = false
  /** The IBL build in flight, if any — the compile gate waits on it. */
  private envPending: Promise<void> | null = null
  /** Bumped on every release, so a build that lands late is dropped. */
  private envSeq = 0
  /** The lit post stack (own lazy chunk; null = composer-less render). */
  private post: PostStack | null = null
  private postLoading = false
  /** Auto-degrade bookkeeping (lit frames only): EMA of renderFrame cost. */
  private frameCostEma = 0
  private slowFrames = 0
  /** rAF timestamp of the last rendered frame (0 = the loop went idle). */
  private lastRenderAt = 0
  /** performance.now() when the last rendered tick finished its work… */
  private lastTickEnd = 0
  /** …and when the rAF that runs the NEXT tick was requested (governor). */
  private rafRequestedAt = 0

  // ── scene decoration (per-diagram shared setting — decor track) ────────────
  private sceneDecor: SceneDecor3D | null = null
  /** Background world actually built by the last buildFloor (probe/e2e). */
  private bgWorldBuilt: 'workbench' | 'city' | 'studio' | 'void' | null = null
  private decorBuild: DecorBuildResult | null = null
  /** Blender decor meshes in flight / arrived (see buildDecor). */
  private decorAssetsPending: Promise<void> | null = null
  private decorAssetsSettled = false
  /** City background geometry, cached per (board footprint, seed): every
   * full rebuild re-dresses it with fresh materials instead of re-running
   * the 59-78 ms builder (view3d-quality 2026-10-08, `floorMs` on city). */
  private cityGeom: { key: string; geom: CityGeometry } | null = null
  /** The in-flight time-sliced city build (null once settled or cancelled). */
  private cityJob: { key: string; promise: Promise<CityGeometry | null> } | null = null
  /** Resolves once the current floor's city is attached — the compile gate
   * waits on it, so the previous frame stays on screen meanwhile. */
  private cityPending: Promise<void> | null = null
  /** The current floor's city mount point (cleared by clearRoot). */
  private cityHolder: THREE.Group | null = null
  /** Lit slab geometries (bevel + creased normals) by dimensions. The cards,
   * plinths and board slab of a rebuild mostly repeat the same few sizes,
   * and `toCreasedNormals` was ~24 ms of every full rebuild (profile of the
   * city decor pick, 2026-10-08). Entries no rebuild used are released at
   * the end of the next full rebuild. */
  private slabGeoCache = new Map<string, THREE.BufferGeometry>()
  private slabGeoUsed = new Set<string>()
  /** Debug/perf: wall-clock cost of the last FULL rebuild (perfInfo probe). */
  private buildTimings = {
    totalMs: 0,
    floorMs: 0,
    decorMs: 0,
    builds: 0,
    firstFrameMs: 0,
    compileMs: 0,
    postFirstMs: 0,
    postFirstShadowMs: 0,
    /** `builds` when the first-frame probe last fired (-1: not yet this build). */
    postFirstBuild: -1,
    postFirstComposed: false,
  }
  /** First-frame probe, armed by every full rebuild AND by the post-stack
   * mount: the next presented frame (plus the shadow pass split ahead of it,
   * see `primeShadowPass`) reports its own wall time and the programs it
   * still had to link. Re-armed per build so a rebuild never reports the
   * previous build's frame (loop1-r2 carried enter-3D's 170.300000011 ms
   * into the city pick, bit-identical). */
  private postFirstRenderPending = false
  /** Programs live before the probed frame's shadow pass (null: not started). */
  private postFirstBefore: Set<unknown> | null = null
  private postFirstNewPrograms: string[] = []
  private postFirstPriorPrograms: string[] = []
  private firstFramePending = false
  /** Scene-owned gradient backdrop (see backdrop.ts) — replaces a texture
   * `scene.background`, which the async compile gate cannot reach. */
  private backdrop: GradientBackdrop | null = null
  /** Shadow-depth programs warmed by the compile gate (see lit/shadowWarm.ts). */
  private readonly depthWarmer = new ShadowDepthWarmer()
  /** 1×1 target bound while the depth variants compile: three keys a program
   * on whether a target is bound (linear output, no tone mapping), and the
   * shadow pass always draws into one. */
  private depthWarmTarget: THREE.WebGLRenderTarget | null = null
  /** Camera that sees nothing — renders the shadow map alone (primeShadowPass). */
  private shadowPrimeCamera: THREE.PerspectiveCamera | null = null
  /** Async shader compile gate — see `scheduleCompile`. */
  private compiling = false
  private compileSeq = 0
  private compileWaiters: (() => void)[] = []
  /** When the gate first closed (0 = open): the ceiling is anchored HERE, so a
   * stream of superseding rebuilds cannot hold the loop indefinitely. */
  private compileGateSince = 0
  /** An enter morph is committed but its tween has not started (holdForEnter). */
  private enterPending = false
  /** Bumped by every enter/exit: a deferred enter checks it is still current. */
  private enterGen = 0
  private decorRefreshTimer: ReturnType<typeof setTimeout> | null = null
  /** The idle callback a fired decorRefreshTimer handed the rebuild to. */
  private decorRefreshIdle: number | null = null
  /** Floor pad/fracture actually used by the last buildFloor (decor inputs). */
  private lastFloorPad = { x: 88, y: 72 }
  private lastFractureBand = 0

  private canvas: HTMLCanvasElement
  private callbacks: Scene3DCallbacks

  constructor(canvas: HTMLCanvasElement, callbacks: Scene3DCallbacks) {
    this.canvas = canvas
    this.callbacks = callbacks
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    // three's shader-error check reads each program's link status and info
    // log on first use — a SYNCHRONOUS round trip that makes the page wait for
    // the GPU process to finish compiling. Without it a pending compile delays
    // the frame on the GPU side only; the main thread (UI, input) stays free.
    // Kept in development, where a broken shader must fail loudly.
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV
    this.measureVsync()
    this.rig = new CameraRig(() => this.requestCameraRender())
    this.scene.add(this.root)
    this.scene.add(this.smartGuideLayer)
    this.smartGuideLayer.name = 'smart-guides'
    preloadFonts(() => this.requestRender())
    this.attach()
    const rebuildLocalizedText = () => {
      this.buildSignature = ''
      this.rebuild()
    }
    i18n.on('languageChanged', rebuildLocalizedText)
    this.detachFns.push(() => i18n.off('languageChanged', rebuildLocalizedText))
    // Register as the live board so the Export tab can capture it without
    // importing the WebGL chunk. Last mount wins; dispose clears only if it's us.
    setActiveScene3D(this)

    // Dev-only introspection for honest e2e assertions (never used by app code).
    // Assigned to a TYPED target (`scene3dProbe.ts` augments Window), so the
    // compiler checks the key as well as the shape — through the old
    // `Record<string, unknown>` cast, any key at all typechecked.
    // VITE_SCENE3D_PROBE=on keeps it in a production build, so the quality loop
    // (scripts/view3d-quality) can measure load time on bundled code.
    if (import.meta.env.DEV || import.meta.env.VITE_SCENE3D_PROBE === 'on') {
      window.__scene3d = {
        getPose: () => this.rig.getPose(),
        // the base design pose the enter morph lands on (enterTargetPose)
        presetPose: () => this.rig.presetPoseFor(this.preset, this.contentBounds()),
        // honest readiness: a committed-but-unstarted enter and a pending
        // shader link are part of "the camera is still moving into place"
        // …and while a sliced label placement pass is pending (the plates
        // still show the previous pass): a probe reading labels before it
        // commits would grade a state nobody settles on
        isCameraAnimating: () =>
          this.rig.isAnimating() ||
          this.enterPending ||
          this.compiling ||
          this.connCompiling ||
          this.decorRebuildRaf !== null ||
          this.labelJob !== null,
        enterPending: () => this.enterPending,
        /** Morph floor fade (0 = flat 2D reading, 1 = dressed board). */
        floorAlpha: () => this.floorAlpha,
        /** The pose the last enter morph STARTED from (framing identity). */
        enterStartPose: () => (this.lastEnterStart ? { ...this.lastEnterStart } : null),
        /** Debug/e2e: the RENDERED RGBA at client coords (renders synchronously
         * first, then reads the drawing buffer in the same task). Raycast
         * probes can't see draw-order bugs — the invisible-connections
         * regression passed every geometry assertion; only pixels catch it. */
        readPixel: (clientX: number, clientY: number) => {
          this.scene.updateMatrixWorld()
          this.renderFrame()
          const gl = this.renderer.getContext()
          const rect = this.canvas.getBoundingClientRect()
          const pr = this.renderer.getPixelRatio()
          const x = Math.round((clientX - rect.left) * pr)
          const y = Math.round(gl.drawingBufferHeight - (clientY - rect.top) * pr)
          const buf = new Uint8Array(4)
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
          return { r: buf[0], g: buf[1], b: buf[2], a: buf[3] }
        },
        /** Blend/depth state of the floor materials (the layering invariant). */
        floorFadeState: () =>
          this.floorFade.map((f) => ({ transparent: f.mat.transparent, depthWrite: f.mat.depthWrite })),
        /** Theme 3D surface state (edge glows, motions, environment). */
        theme3dInfo: () => {
          let glowCount = 0
          this.root.traverse((obj) => {
            if (obj.userData.edgeGlow) glowCount++
          })
          return {
            hasTheme: !!this.theme3d,
            glowCount,
            motionCount: this.motionUnits.length,
            fog: !!this.scene.fog,
            // the gradient is a scene-owned backdrop mesh now (backdrop.ts)
            bgIsGradient: this.backdrop?.visible === true && this.backdrop.parent === this.scene,
          }
        },
        nodeCount: () => this.nodeGroups.size,
        rendererInfo: () => ({ ...this.renderer.info.render }),
        /** Debug/e2e: perf-gate counters. Renders once so `calls`/`triangles`
         * reflect the CURRENT camera (frustum culling included). `texts`/`meshes`
         * are the built totals; `visibleTexts` tracks the LOD hide state. */
        sceneStats: (): Scene3dSceneStats => {
          // Accumulate renderer.info across the WHOLE frame: with the lit
          // composer active a frame is several internal renders (scene pass,
          // bloom mips, fullscreen quad) and per-render auto-reset would
          // report only the LAST one (1 call / 1 triangle — a vacuous gate).
          // Unlit frames are a single render, so manual reset changes nothing
          // there.
          const info = this.renderer.info
          const prevAuto = info.autoReset
          info.autoReset = false
          info.reset()
          this.renderFrame()
          info.autoReset = prevAuto
          let meshes = 0
          this.root.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) meshes++
          })
          let visibleTexts = 0
          for (const t of this.texts) if (t.visible) visibleTexts++
          for (const t of this.connTexts) if (t.visible) visibleTexts++
          // Render-profile ground truth, measured off the live scene/renderer
          // (not the intent flags) so a probe assertion catches a profile that
          // half-applied: a light left mounted, a shadow map left on, a stray
          // composer pass — any of those is a real state leak between themes.
          let lightsCount = 0
          let shadowCasters = 0
          this.scene.traverse((o) => {
            // a parked practical (intensity 0, kept so programs never recompile) contributes nothing
            if ((o as THREE.Light).isLight && (o as THREE.Light).intensity > 0) lightsCount++
            if ((o as THREE.Mesh).isMesh && o.castShadow) shadowCasters++
          })
          return {
            nodes: this.nodeGroups.size,
            connections: this.data.connections.length,
            meshes,
            texts: this.texts.length + this.connTexts.length,
            visibleTexts,
            calls: this.renderer.info.render.calls,
            triangles: this.renderer.info.render.triangles,
            frame: this.renderer.info.render.frame,
            pixelRatio: this.renderer.getPixelRatio(),
            // Live GPU-side allocation counts (leak accounting):
            // three decrements these on geometry/texture .dispose(), so a
            // rebuild path that leaks shows up as a climbing plateau here.
            geometries: this.renderer.info.memory.geometries,
            textures: this.renderer.info.memory.textures,
            renderProfile: this.renderProfile,
            lightsCount,
            shadowMapEnabled: this.renderer.shadowMap.enabled,
            envMap: !!this.scene.environment,
            composerPasses: this.composerPassCount,
            qualityTier: this.qualityTier,
            shadowCasters,
          }
        },
        /** Debug/e2e: GL context-loss drill. force* use the renderer's
         * WEBGL_lose_context hooks; contextInfo exposes the recovery state so
         * the drill can assert the restore handler genuinely ran. */
        contextInfo: () => ({ lost: this.contextLost, restores: this.contextRestores }),
        forceContextLoss: () => this.renderer.forceContextLoss(),
        /** Debug/e2e: force the lit post tier (deterministic CI budgets). */
        setQualityTier: (tier: 'high' | 'medium' | 'low') => this.setQualityTier(tier),
        /** Debug/e2e: the decoration layer's live state (read-only). */
        decorInfo: (): Scene3dDecorInfo => ({
          packId: this.sceneDecor?.packId ?? null,
          density: this.sceneDecor?.density ?? null,
          seed: this.sceneDecor?.seed ?? null,
          boardStyle: this.sceneDecor?.boardStyle ?? null,
          background: this.sceneDecor?.background ?? null,
          world: this.bgWorldBuilt,
          visible: this.decorBuild?.group.visible ?? false,
          archetypes: this.decorBuild
            ? Object.entries(this.decorBuild.counts).map(([id, count]) => ({ id, count }))
            : [],
        }),
        perfInfo: () => ({
          ...this.buildTimings,
          programs: this.renderer.info.programs?.length ?? 0,
          programNames: (this.renderer.info.programs ?? []).map((p) => p.name),
          // every live program's cache key (names are the material's, ''
          // for nearly all): what a gesture added is a diff of these
          programKeys: (this.renderer.info.programs ?? []).map((p) => String((p as unknown as { cacheKey?: string }).cacheKey ?? '')),
          postFirstNewPrograms: [...this.postFirstNewPrograms],
          postFirstPriorPrograms: [...this.postFirstPriorPrograms],
          postFirstPending: this.postFirstRenderPending,
          postLive: this.post !== null,
          depthWarmVariants: this.depthWarmer.variantCount,
          slowFrames: this.slowFrameLog.map((f) => ({ ...f })),
          warmDraws: this.warmDraws,
          warmDrawMs: this.warmDrawMs,
        }),
        setSlowFrameMs: (ms: number) => {
          this.slowFrameMs = Math.max(1, ms)
        },
        benchFrames: (frames: number) => {
          // Synchronous GPU-honest frame timing: each frame orbits the camera,
          // advances the flow animations, renders through the real pipeline
          // and is FORCED to completion by a 1-px readback, so the interval is
          // the whole CPU+GPU cost — independent of vsync and of rAF pacing.
          const gl = this.renderer.getContext()
          const px = new Uint8Array(4)
          const start = this.rig.getPose()
          const times: number[] = []
          for (let i = 0; i < frames; i++) {
            const t0 = performance.now()
            this.rig.setPose({ ...start, azimuth: (start.azimuth + (i * 90) / frames) % 360 })
            this.stepFlow(t0)
            this.renderFrameInner()
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
            times.push(performance.now() - t0)
          }
          this.rig.setPose(start)
          this.updateNodeLod()
          // only the camera and the flow dots moved: the cached shadow map
          // is still exact (requestCameraRender) — a bench must not leave the
          // next measured window a shadow re-render it did not cause
          this.requestCameraRender()
          return times
        },
        decorProps: (archetypeId: string) => {
          const out: { x: number; y: number; z: number; scale: number; h: number; r: number; corners: [number, number, number][] }[] = []
          const m = new THREE.Matrix4()
          const v = new THREE.Vector3()
          const s = new THREE.Vector3()
          this.decorBuild?.group.updateMatrixWorld(true)
          this.decorBuild?.group.traverse((o) => {
            const im = o as THREE.InstancedMesh
            if (!im.isInstancedMesh || o.userData.decorArchetype !== archetypeId) return
            // the silhouette's own height (a moose's antler crown included):
            // the quality harness frames its close-ups on it
            if (!im.geometry.boundingBox) im.geometry.computeBoundingBox()
            const bb = im.geometry.boundingBox!
            // …and a rotation-safe plan radius about the origin (the box's
            // farthest corner), so a close-up can frame a FLAT prop too
            const r0 = Math.hypot(Math.max(-bb.min.x, bb.max.x), Math.max(-bb.min.z, bb.max.z))
            for (let i = 0; i < im.count; i++) {
              im.getMatrixAt(i, m)
              m.premultiply(im.matrixWorld)
              v.setFromMatrixPosition(m)
              s.setFromMatrixScale(m)
              // the geometry box's 8 corners in world space (posed, scaled):
              // what the harness projects to frame a close-up exactly
              const corners: [number, number, number][] = []
              for (const cx of [bb.min.x, bb.max.x]) {
                for (const cy of [bb.min.y, bb.max.y]) {
                  for (const cz of [bb.min.z, bb.max.z]) {
                    const w = new THREE.Vector3(cx, cy, cz).applyMatrix4(m)
                    corners.push([w.x, w.y, w.z])
                  }
                }
              }
              out.push({ x: v.x, y: v.y, z: v.z, scale: s.y, h: (bb.max.y - Math.min(0, bb.min.y)) * s.y, r: r0 * Math.max(s.x, s.z), corners })
            }
          })
          return out
        },
        boardInfo: () => (this.boardBox ? { ...this.boardBox } : null),
        decorPlacementInput: () => (this.lastDecorInput ? JSON.parse(JSON.stringify(this.lastDecorInput)) : null),
        decorSilhouettes: (archetypeId: string) => {
          // every instance's projected SILHOUETTE box (its posed vertices
          // through the live camera, ≤ ~4 000 sampled a mesh) — a geometry
          // box's corners overshoot a round or long prop by up to √2
          const rect = this.canvas.getBoundingClientRect()
          const cam = this.rig.camera
          cam.updateMatrixWorld()
          this.decorBuild?.group.updateMatrixWorld(true)
          const out: { x0: number; y0: number; x1: number; y1: number }[] = []
          const m = new THREE.Matrix4()
          const v = new THREE.Vector3()
          this.decorBuild?.group.traverse((o) => {
            const im = o as THREE.InstancedMesh
            if (!im.isInstancedMesh || o.userData.decorArchetype !== archetypeId) return
            const pos = im.geometry.getAttribute('position')
            const step = Math.max(1, Math.floor(pos.count / 4000))
            for (let i = 0; i < im.count; i++) {
              im.getMatrixAt(i, m)
              m.premultiply(im.matrixWorld)
              const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
              for (let k = 0; k < pos.count; k += step) {
                v.fromBufferAttribute(pos, k).applyMatrix4(m).project(cam)
                const sx = rect.left + ((v.x + 1) / 2) * rect.width
                const sy = rect.top + ((1 - v.y) / 2) * rect.height
                b.x0 = Math.min(b.x0, sx)
                b.x1 = Math.max(b.x1, sx)
                b.y0 = Math.min(b.y0, sy)
                b.y1 = Math.max(b.y1, sy)
              }
              out.push(b)
            }
          })
          return out
        },
        projectWorld: (points: { x: number; y: number; z: number }[]) => {
          const rect = this.canvas.getBoundingClientRect()
          const cam = this.rig.camera
          cam.updateMatrixWorld()
          const v = new THREE.Vector3()
          return points.map((p) => {
            v.set(p.x, p.y, p.z).project(cam)
            return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height }
          })
        },
        arrowheadInfo: (): Scene3dArrowhead[] => this.arrowheadProbe(),
        connLayerInfo: (): Scene3dConnLayer => {
          // what the connection layer is made of: geometry types by count,
          // the ink meshes (casings + cores), and whether anything casts a
          // shadow (the lit cables did; the ink lines must not)
          const geometryTypes: Record<string, number> = {}
          let inkMeshes = 0
          let inkCores = 0
          let shadowCasters = 0
          this.connLayer.traverse((o) => {
            const mesh = o as THREE.Mesh
            if (!mesh.isMesh || this.connTexts.includes(o as Text)) return
            geometryTypes[mesh.geometry.type] = (geometryTypes[mesh.geometry.type] ?? 0) + 1
            if (o.userData.ink) inkMeshes++
            if (o.userData.ink === 'core') inkCores++
            if (mesh.castShadow) shadowCasters++
          })
          return {
            geometryTypes,
            inkMeshes,
            inkCores,
            shadowCasters,
            inkSet: this.renderProfile === 'lit' ? this.inkSet() : null,
          }
        },
        setPose: (pose: Partial<Scene3dPose>) => {
          this.rig.setPose({ ...this.rig.getPose(), ...pose })
          // a jump-cut lands at once: what a settled camera re-evaluates
          // (LOD, the labels it shows, the chevrons it sees) follows, as it
          // would after an orbit that ended here
          this.updateNodeLod()
          this.requestRender()
        },
        forceContextRestore: () => this.renderer.forceContextRestore(),
        /** Debug/e2e: showcase auto-orbit state (on + currently held?). */
        showcaseInfo: () => ({
          on: this.showcase,
          holding: this.pointer.mode !== 'idle' || performance.now() < this.showcaseHoldUntil,
        }),
        nodeWorldPos: (id: string) => {
          const g = this.nodeGroups.get(id)
          return g ? { x: g.position.x, y: g.position.z } : null
        },
        nodeIds: () => [...this.nodeGroups.keys()],
        textLegibility: () => {
          // the projected CAP HEIGHT (css px) of every node title on screen
          // and every connection label: the glyph's up axis (local +y) taken
          // through the text's own world matrix and projected at its anchor
          // (world −Z: the card title and the drum's floor-tag name lie flat)
          const cam = this.rig.camera
          cam.updateMatrixWorld()
          this.scene.updateMatrixWorld()
          const rect = this.canvas.getBoundingClientRect()
          const a = new THREE.Vector3()
          const b = new THREE.Vector3()
          const capPx = (t: Text): number => {
            a.set(0, 0, 0).applyMatrix4(t.matrixWorld)
            b.set(0, (t.fontSize as number) * INTER_CAP_EM, 0).applyMatrix4(t.matrixWorld)
            a.project(cam)
            b.project(cam)
            return Math.hypot(((b.x - a.x) / 2) * rect.width, ((b.y - a.y) / 2) * rect.height)
          }
          const titles: { id: string; kind: 'card' | 'store'; capPx: number }[] = []
          for (const [id, unit] of this.nodeGroups) {
            for (const child of unit.children) {
              const store = child.userData.storeTag === 'text'
              if (!child.visible || !(store || child.userData.cardContentRole === 'title')) continue
              titles.push({ id, kind: store ? 'store' : 'card', capPx: capPx(child as Text) })
            }
          }
          const labels = this.connTexts.filter((t) => t.visible).map((t) => ({ text: String(t.text), capPx: capPx(t), k: t.scale.x }))
          return { titles, labels, growth: { ...this.connLabelGrowth, labels: this.connLabelGrowth.labels.map((l) => ({ ...l })) } }
        },
        nodeScreenBoxes: () => {
          const rect = this.canvas.getBoundingClientRect()
          const cam = this.rig.camera
          cam.updateMatrixWorld()
          const v = new THREE.Vector3()
          return this.nodeFitBoxes().map(({ id, corners }) => {
            let x0 = Infinity
            let y0 = Infinity
            let x1 = -Infinity
            let y1 = -Infinity
            for (const c of corners) {
              v.set(c.x, c.y, c.z).project(cam)
              const sx = rect.left + ((v.x + 1) / 2) * rect.width
              const sy = rect.top + ((1 - v.y) / 2) * rect.height
              x0 = Math.min(x0, sx)
              y0 = Math.min(y0, sy)
              x1 = Math.max(x1, sx)
              y1 = Math.max(y1, sy)
            }
            return { id, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
          })
        },
        nodeFaces: () => {
          // what each node's face shows right now (USER REGRESSION
          // 2026-10-10: the far-title mode had replaced every card's face at
          // the wide framing — Inter 700 at up to 34, no badge, no subtitle —
          // and the drums' names had moved onto the drum in bold). Per node:
          // its title text block (the card name, or the drum's floor-tag
          // name) with font / size / visibility, its technology / type badge
          // (shown? scale?), and any text block in a font the base design
          // never used for a node face.
          const BASE_FONTS = new Set(['inter400', 'inter600'])
          const out: {
            id: string
            kind: 'card' | 'store'
            hasTech: boolean
            title: { font: string; size: number; visible: boolean } | null
            badge: { visible: boolean; scale: number } | null
            foreignFonts: string[]
          }[] = []
          for (const [id, unit] of this.nodeGroups) {
            let title: { font: string; size: number; visible: boolean } | null = null
            let badge: { visible: boolean; scale: number } | null = null
            const foreignFonts: string[] = []
            for (const child of unit.children) {
              const font = child.userData.fontId as string | undefined // text.makeText
              if (font !== undefined && !BASE_FONTS.has(font)) foreignFonts.push(font)
              if (child.userData.cardContentRole === 'title' || child.userData.storeTag === 'text') {
                title = { font: font ?? '?', size: (child as Text).fontSize as number, visible: child.visible }
              }
              if (child.userData.cardContentRole === 'icon' || child.userData.drumBadge === true) {
                badge = { visible: child.visible, scale: child.scale.x }
              }
            }
            out.push({
              id,
              kind: unit.userData.nodeKind === 'store' ? 'store' : 'card',
              hasTech: unit.userData.hasTech === true,
              title,
              badge,
              foreignFonts,
            })
          }
          return out
        },
        labelScreenInfo: () => {
          // every lit connection label plate's four corners as DRAWN (its
          // geometry box through its own world matrix — scale and lift
          // included), and every node solid's points, through the LIVE
          // camera in client css px (quality pass "labels")
          const rect = this.canvas.getBoundingClientRect()
          const cam = this.rig.camera
          cam.updateMatrixWorld()
          this.scene.updateMatrixWorld()
          const v = new THREE.Vector3()
          const proj = (x: number, y: number, z: number) => {
            v.set(x, y, z).project(cam)
            return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height }
          }
          const labels = this.connLabelScalers
            .filter((s) => s.plate.visible && s.text.visible)
            .map((s) => {
              const g = s.plate.geometry
              if (!g.boundingBox) g.computeBoundingBox()
              const bb = g.boundingBox!
              const pts = [
                [bb.min.x, bb.min.z],
                [bb.max.x, bb.min.z],
                [bb.max.x, bb.max.z],
                [bb.min.x, bb.max.z],
              ].map(([x, z]) => {
                const w = new THREE.Vector3(x, bb.max.y, z).applyMatrix4(s.plate.matrixWorld)
                return proj(w.x, w.y, w.z)
              })
              return { connId: s.connId, text: String(s.text.text), k: s.text.scale.x, pts }
            })
          const nodes = this.nodeSolids().map((n) => ({ id: n.id, kind: n.kind, pts: n.pts.map((p) => proj(p.x, p.y, p.z)) }))
          return { labels, nodes }
        },
        storeTagInfo: () => {
          // each drum's floor tag (storeTagRect): its plate's four top
          // corners in WORLD space as drawn, its text and whether both show
          // (LOD) — the harness frames each one and gates it whole on the
          // canvas and clear of every node on screen (quality pass "labels"
          // round 2: 'PostgreSQL' / 'Elasticsearch' tucked under the drums)
          this.scene.updateMatrixWorld()
          const out: { id: string; text: string; visible: boolean; corners: { x: number; y: number; z: number }[] }[] = []
          for (const [id, unit] of this.nodeGroups) {
            const plate = unit.children.find((c) => c.userData.storeTag === 'plate') as THREE.Mesh | undefined
            const text = unit.children.find((c) => c.userData.storeTag === 'text') as Text | undefined
            if (!plate || !text) continue
            const g = plate.geometry
            if (!g.boundingBox) g.computeBoundingBox()
            const bb = g.boundingBox!
            const corners = [
              [bb.min.x, bb.min.z],
              [bb.max.x, bb.min.z],
              [bb.max.x, bb.max.z],
              [bb.min.x, bb.max.z],
            ].map(([x, z]) => {
              const w = new THREE.Vector3(x, bb.max.y, z).applyMatrix4(plate.matrixWorld)
              return { x: w.x, y: w.y, z: w.z }
            })
            out.push({ id, text: String(text.text), visible: plate.visible && text.visible, corners })
          }
          return out
        },
        connLabelPerf: () => ({ ...this.connLabelPerf }),
        connLabelStates: () => {
          // TASK 2: what each lit label shows at the current framing (whole,
          // abbreviated, hidden), whether hover / selection forces it whole,
          // and its own cable's centreline in WORLD space — the harness
          // hovers a hidden label's wire with the real pointer
          this.scene.updateMatrixWorld()
          const layerM = this.connLayer.matrixWorld
          return this.connLabelScalers.map((s) => ({
            connId: s.connId,
            text: s.fullText,
            state: s.shown.state,
            shown: s.shown.text,
            drawn: s.plate.visible && s.text.visible,
            textNow: String(s.text.text),
            hovered: this.connLabelHoverId === s.connId,
            selected: this.selectedIds.has(s.connId),
            k: s.k,
            spots: s.spots.length,
            wire: (this.connLines.get(s.connId) ?? []).map((p) => {
              const w = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(layerM)
              return { x: w.x, y: w.y, z: w.z }
            }),
          }))
        },
        connLabelWireInfo: () => {
          // each visible lit label plate's WORLD centre as drawn (its geometry
          // box through its own world matrix — scale and lift included), its
          // drawn half extents, and its own line's centreline as built (the
          // ribbon's samples, layer-local -> world). Quality pass
          // "labels" round 2: the harness gates plate-to-own-wire distance.
          this.scene.updateMatrixWorld()
          const layerM = this.connLayer.matrixWorld
          return this.connLabelScalers
            .filter((s) => s.plate.visible && s.text.visible)
            .map((s) => {
              const g = s.plate.geometry
              if (!g.boundingBox) g.computeBoundingBox()
              const bb = g.boundingBox!
              const c = new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.max.y, (bb.min.z + bb.max.z) / 2).applyMatrix4(s.plate.matrixWorld)
              const sx = new THREE.Vector3()
              s.plate.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sx)
              const wire = (this.connLines.get(s.connId) ?? []).map((p) => {
                const w = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(layerM)
                return { x: w.x, y: w.y, z: w.z }
              })
              return {
                connId: s.connId,
                text: String(s.text.text),
                k: s.text.scale.x,
                centre: { x: c.x, y: c.y, z: c.z },
                halfW: ((bb.max.x - bb.min.x) * sx.x) / 2,
                halfH: ((bb.max.z - bb.min.z) * sx.z) / 2,
                wire,
              }
            })
        },
        /** Debug/probe: the background world's fabric manifest (walk-up /
         * cornice / roof-treatment counts for the Montréal city ring). */
        cityFabricInfo: () => {
          let found: unknown = null
          this.root.traverse((o) => {
            if (o.userData.cityFabric) found = o.userData.cityFabric
          })
          return found
        },
        /** Debug/probe: the city's Mont-Royal — which mesh it wears and its
         * WORLD box (the drawn `city-mount` part), for the harness close-up. */
        cityMountInfo: () => {
          let out: Scene3dCityMount | null = null
          this.root.updateMatrixWorld()
          this.root.traverse((o) => {
            const seat = o.userData.cityMount as { r: number; source: 'glb' | 'procedural' } | null | undefined
            if (out || !seat) return
            let mesh: THREE.Mesh | null = null
            o.traverse((c) => {
              if (!mesh && c.userData.bgPart === 'city-mount') mesh = c as THREE.Mesh
            })
            if (!mesh) return
            const box = new THREE.Box3().setFromObject(mesh)
            const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3
            out = {
              source: seat.source,
              min: [box.min.x, box.min.y, box.min.z],
              max: [box.max.x, box.max.y, box.max.z],
              radius: seat.r,
              triangles: tris((mesh as THREE.Mesh).geometry),
            }
          })
          return out
        },
        smartGuideInfo: () => ({
          guides: this.smartGuides.map((guide) => ({ ...guide })),
          candidates: this.smartGuideCandidates.length,
          snapped: { ...this.smartGuideSnap },
          lastDropSnap: { ...this.lastDropGuideSnap },
        }),
        /** Debug/e2e: the expand glyph's world center + LOD visibility on a
         * node (Model Viewer drill affordance) — read-only, so tests can aim
         * a REAL click at the right pixels. */
        expandGlyphInfo: (id: string) => {
          const g = this.nodeGroups.get(id)
          if (!g) return null
          this.scene.updateMatrixWorld()
          let out: { x: number; y: number; z: number; visible: boolean } | null = null
          g.traverse((obj) => {
            if (obj.userData.expandGlyph) {
              const p = new THREE.Vector3()
              obj.getWorldPosition(p) // plate origin = its top-left corner
              out = { x: p.x + 13, y: p.y, z: p.z + 13, visible: obj.visible }
            }
          })
          return out
        },
        /** Debug/e2e: fly the camera to a world point at the given distance. */
        focusWorld: (x: number, z: number, distance: number) => {
          const pose = this.rig.getPose()
          this.rig.tweenTo({ ...pose, targetX: x, targetZ: z, distance })
        },
        /** Debug/e2e: what a pointer at these client coords would pick (read-only). */
        pickAt: (clientX: number, clientY: number) => this.pickClient(clientX, clientY)?.target ?? null,
        connectionIds: () => this.data.connections.map((c) => c.id),
        /** Debug/e2e: focus-flow animation state (2D-parity focus effects).
         * `phase` is the first unit's normalized animation phase — asserting
         * progress on it is robust to path length and frame pacing. */
        flowInfo: () => ({
          units: this.flowUnits.length,
          kinds: this.flowUnits.map((u) => u.kind),
          dotPos: this.flowUnits[0]?.dot
            ? { x: this.flowUnits[0].dot.position.x, z: this.flowUnits[0].dot.position.z }
            : (this.flowUnits[0]?.pos ?? null),
          phase: this.flowUnits[0]?.lastT ?? null,
        }),
        /** Debug/e2e: the grid toggle + whether the floor dots currently show. */
        gridInfo: () => ({
          showGrid: this.showGrid,
          dotsVisible: this.floorGridToggle
            ? !this.floorGridToggle.uniform.value.equals(this.floorGridToggle.off)
            : this.litFloorGrid
              ? this.litFloorGrid.mat.map !== this.litFloorGrid.off
              : false,
        }),
        /** Debug/e2e: mounted theme assets — custom bodies by asset id, the
         * floorTexture flag, whether the sky is an equirect texture, and the
         * voxel-scatter instance count (FloorSpec3D.scatter). */
        assetInfo: () => {
          const mounted: string[] = []
          let voxels = 0
          this.root.traverse((obj) => {
            if (typeof obj.userData.assetBody === 'string') mounted.push(obj.userData.assetBody)
            if (typeof obj.userData.voxelScatter === 'number') voxels += obj.userData.voxelScatter
          })
          return {
            mounted,
            billboards: this.billboards.length,
            floorTextured: this.floorTextured,
            bgIsEquirect:
              this.scene.background instanceof THREE.Texture &&
              this.scene.background.mapping === THREE.EquirectangularReflectionMapping,
            voxels,
          }
        },
        /** Debug/e2e: loose floor fragments and their current scene-only state. */
        voxelInfo: () => {
          const live = this.voxelScatter
          if (!live) return { count: 0, interactive: false, displaced: 0, fragments: [] }
          this.scene.updateMatrixWorld()
          return {
            count: live.fragments.size,
            interactive: live.interactive,
            displaced: this.voxelTransient.size,
            fragments: [...live.fragments.values()].map((fragment) => {
              const world = live.floor.localToWorld(fragment.position.clone())
              return { id: fragment.id, x: world.x, y: world.y, z: world.z }
            }),
          }
        },
        /** Debug/e2e: shadow shapes on the board — every rectangular caster
         * (cards, the floor slab) must cast a roundedRect SDF shadow, not the
         * radial blob (which reads as an oval under rectangles); drums keep
         * the blob. */
        shadowInfo: () => {
          const shapes: string[] = []
          this.root.traverse((obj) => {
            if (typeof obj.userData.shadowShape === 'string') shapes.push(obj.userData.shadowShape)
          })
          return shapes
        },
        /** Debug/e2e: technology-icon decals on the board (obj/group icons). */
        techIcons: () => {
          const names: string[] = []
          this.root.traverse((obj) => {
            if (typeof obj.userData.techIcon === 'string') names.push(obj.userData.techIcon)
          })
          return names
        },
        /** Debug/e2e: renderer-neutral card-content anchors mapped onto the
         * 3D card's X/Z plane. All identity roles must share the centre X. */
        cardContentInfo: (id: string) => {
          const unit = this.nodeGroups.get(id)
          if (!unit) return []
          const items: Array<{
            role: string
            x: number
            z: number
            lineCount?: number
            fontSize?: number
            truncated?: boolean
            text?: string
          }> = []
          unit.traverse((obj) => {
            const role = obj.userData.cardContentRole
            const anchor = obj.userData.cardContentAnchor as { x?: number; z?: number } | undefined
            if (typeof role === 'string' && typeof anchor?.x === 'number' && typeof anchor.z === 'number') {
              items.push({
                role,
                x: anchor.x,
                z: anchor.z,
                lineCount: typeof obj.userData.cardContentLineCount === 'number'
                  ? obj.userData.cardContentLineCount
                  : undefined,
                fontSize: typeof obj.userData.cardContentFontSize === 'number'
                  ? obj.userData.cardContentFontSize
                  : undefined,
                truncated: typeof obj.userData.cardContentTruncated === 'boolean'
                  ? obj.userData.cardContentTruncated
                  : undefined,
                text: typeof (obj as Text).text === 'string' ? (obj as Text).text : undefined,
              })
            }
          })
          return items
        },
        /** Debug/e2e: every accent-bar segment currently on the board (bottom
         * "color by" bars) as its resolved css color. */
        accentBars: () => {
          const colors: string[] = []
          this.root.traverse((obj) => {
            if (typeof obj.userData.accentBar === 'string') colors.push(obj.userData.accentBar)
          })
          return colors
        },
        /** Debug/e2e: a connection ribbon's effective opacity (focus dim). */
        connectionAlpha: (id: string) => {
          let found: number | null = null
          this.connLayer.traverse((o) => {
            const pick = o.userData.pick as PickTarget | undefined
            if (pick?.kind === 'connection' && pick.id === id) {
              found = ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity
            }
          })
          return found
        },
        /** Debug/e2e: the scene-side selection (lags the store by a React
         * effect — gestures that need edit handles must wait for it). */
        selectionIds: () => [...this.selectedIds],
        /** Debug/e2e: per-group platform state — the derived rect (autoSize
         * re-hug), the rect the plate was BUILT with (fast-path resize proof),
         * and whether the built plate carries the selection visual. */
        groupInfo: () =>
          this.data.groups.map((g) => {
            const plate = this.groupPlates.get(g.id)
            return {
              id: g.id,
              rect: this.groupRect(g),
              builtRect: (plate?.userData.rect as Rect | undefined) ?? null,
              platePos: plate ? { x: plate.position.x, y: plate.position.z } : null,
              selectedVisual: plate?.userData.groupSelected === true,
              members: g.objectIds.length,
            }
          }),
        /** Debug/e2e: world-space edit points of a connection (endpoints, mid,
         * label center, bends) + the connection plane height — read-only, so
         * tests can aim REAL pointer gestures at the right pixels. */
        connEditPoints: (id: string) => {
          const geom = this.connGeoms.get(id)
          const conn = this.data.connections.find((c) => c.id === id)
          if (!geom || !conn) return null
          const t = conn.labelPosition ?? 0.5
          const off = Math.max(-40, Math.min(40, conn.labelOffset ?? 0))
          const pt = pathPoint(geom, t)
          const tan = pathTangent(geom, t)
          // the lit chrome's handles sit on the drawn line (the source on its
          // first point, the target knob behind the head; the head itself
          // when the knob is hidden)
          const chrome = this.editChrome?.connId === id ? this.editChrome : null
          const src = chrome?.items.find((h) => h.role === 'source')
          const knob = chrome?.items.find((h) => h.role === 'knob')
          const head = chrome ? this.arrowDebug.find((a) => a.connId === id)?.head : undefined
          const to = knob?.visible ? { x: knob.x, y: knob.z } : head ? { x: head.x - Math.cos(head.angle) * 5, y: head.z - Math.sin(head.angle) * 5 } : null
          return {
            from: src ? { x: src.x, y: src.z } : { x: geom.fromEdge.x, y: geom.fromEdge.y },
            to: to ?? { x: geom.toEdge.x, y: geom.toEdge.y },
            mid: pathPoint(geom, 0.5),
            label: conn.label ? { x: pt.x - tan.y * off, y: pt.y + tan.x * off } : null,
            waypoints: (conn.waypoints ?? []).map((w) => ({ ...w })),
            planeY: this.connLayer.position.y,
          }
        },
        editHandleInfo: () => {
          const chrome = this.editChrome
          if (!chrome) return null
          this.updateEditHandles()
          const cam = this.rig.camera
          const rect = this.canvas.getBoundingClientRect()
          cam.updateMatrixWorld()
          this.connLayer.updateWorldMatrix(true, false)
          const layerM = this.connLayer.matrixWorld
          const scr = (x: number, y: number, z: number) => {
            const p = new THREE.Vector3(x, y, z).applyMatrix4(layerM).project(cam)
            return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
          }
          const dark = this.palette?.dark === true
          const handles = chrome.items.map((h) => {
            const s = scr(h.x, h.y, h.z)
            const look = handleStyle(h.kind, dark)
            const d = this.handleDrawnDiameter(h)
            return {
              role: h.role,
              kind: h.kind,
              id: h.id,
              visible: h.visible,
              x: +s.x.toFixed(2),
              y: +s.y.toFixed(2),
              diameterPx: +d.toFixed(2),
              bodyPx: +(look.diameter - 2 * look.ringW).toFixed(2),
              hitPx: handleHitRadius(look.diameter),
              ly: h.y,
            }
          })
          // the endpoint-drag preview as built (its ink attributes)
          let preview: { name: string; minCss: number; maxCss: number; dash: number[]; opacity: number; css: string } | null = null
          this.connLayer.traverse((o) => {
            if (o.userData.ink !== 'preview') return
            const g = (o as THREE.Mesh).geometry
            const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial
            const p = g.getAttribute('aParam')
            const c = g.getAttribute('aCap')
            const ds = g.getAttribute('aDash')
            preview = {
              name: o.name,
              minCss: 2 * p.getY(0),
              maxCss: 2 * c.getX(0),
              // [on, period] in css px at the orbit target's scale
              dash: [ds.getX(0), ds.getY(0)].map((x) => +(x / this.inkUniforms.uInkWppTarget.value).toFixed(2)),
              opacity: m.opacity,
              css: '#' + m.color.getHexString(THREE.SRGBColorSpace),
            }
          })
          // the bead: centre on screen, its fade and clearance
          const beadUnit = this.flowUnits.find((u) => u.bead?.connId === chrome.connId && u.pos)
          const lineY = this.connLines.get(chrome.connId)?.[0]?.y ?? 0
          const bead = beadUnit
            ? { ...scr(beadUnit.pos!.x, lineY, beadUnit.pos!.z), fade: +beadUnit.bead!.fade.toFixed(4), clearPx: +beadUnit.bead!.clearPx.toFixed(2), phase: beadUnit.lastT ?? null }
            : null
          const arrow = this.arrowDebug.find((a) => a.connId === chrome.connId)
          const head = arrow ? this.inkHeadAt(arrow, cam, rect.height).tri.map((q) => scr(q.x, q.y, q.z)) : null
          const knob = handles.find((h) => h.role === 'knob' && h.visible)
          let gap: number | null = null
          let knobTip: number | null = null
          // the knob's disc edge to the head triangle, as drawn, and its
          // centre to the tip (it sits ON the tip: the 2D destination dot)
          if (knob && head) {
            gap = +discTriangleGap(knob, knob.diameterPx / 2, head).toFixed(2)
            knobTip = +Math.hypot(knob.x - head[0].x, knob.y - head[0].y).toFixed(2)
          }
          const line = this.connLines.get(chrome.connId)
          const src = handles.find((h) => h.role === 'source')
          const first = line?.[0] ? scr(line[0].x, line[0].y, line[0].z) : null
          return {
            connId: chrome.connId,
            handles,
            head,
            knobHeadGapPx: gap,
            knobTipPx: knobTip,
            sourceOffLinePx: src && first ? +Math.hypot(src.x - first.x, src.y - first.y).toFixed(2) : -1,
            hover: { id: this.handleUniforms.uHoverId.value, t: this.handleUniforms.uHoverT.value },
            pressId: this.handleUniforms.uPressId.value,
            knobOccluded: chrome.knobOccluded === true,
            preview,
            bead,
            haloOpacity: this.selectHalo ? +(this.selectHalo.mat as THREE.MeshBasicMaterial).opacity.toFixed(4) : null,
            haloBase: this.selectHalo?.base ?? null,
            handleOrder: (() => {
              let o = -1
              this.connLayer.traverse((x) => {
                if (x.name === 'edit-handles' || x.name === 'edit-handles-xray') o = Math.max(o, x.renderOrder)
              })
              return o
            })(),
            // the label plates and their text, as drawn
            labelOrderMax: Math.max(-1, ...this.connLabelScalers.map((s) => s.plate.renderOrder), ...this.connTexts.map((t) => t.renderOrder)),
            minHandleOrder: (() => {
              let o = Infinity
              this.connLayer.traverse((x) => {
                if (x.name === 'edit-handles' || x.name === 'edit-handles-xray') o = Math.min(o, x.renderOrder)
              })
              return o
            })(),
          }
        },
        // `satisfies`, not a cast, and it is the whole point of the type.
        //
        // Seven e2e spec files each described this object in their own
        // `declare global`, and they disagreed — see `scene3dProbe.ts` for what
        // the first merged program measured. This one line makes `npm run build`
        // the comparison: a member added here without being declared there is an
        // excess-property error, a member declared there and not installed here
        // is a missing-property error.
        // `satisfies` on top of the typed target, and it is not redundant for
        // two reasons. It names the contract at the point a reader is editing
        // the literal; and it is what USES the `import type` above, which is
        // what keeps `scene3dProbe.ts` in this program — and a global
        // augmentation only applies while its module is in the program. Drop
        // the import and `window.__scene3d` stops existing here (TS2339).
      } satisfies Scene3dProbe
      this.devProbeIdentity = window.__scene3d
    }
  }

  // ── host API ───────────────────────────────────────────────────────────────

  /** Last css size `setSize` applied (null: never called). */
  private hostSize: { w: number; h: number } | null = null

  setSize(width: number, height: number): void {
    // A ResizeObserver callback with the size unchanged (layout settling
    // while the enter crossfade runs) must not reallocate anything: at DPR 2
    // post.setSize re-creates the composer's MSAA buffers, the AO targets and
    // the bloom mip chain at 3200 x 2000, and the next composed frame pays
    // their allocation (loop4-r1-dpr2: one 277 ms composed frame ~680 ms
    // after the first one, DPR 2 only).
    // (compared with the last size the HOST gave, not renderer.getSize: the
    // renderer starts at the canvas default 300 x 150, which a first call of
    // that exact size must still apply to the rig)
    if (this.hostSize && this.hostSize.w === width && this.hostSize.h === height) return
    this.hostSize = { w: width, h: height }
    this.resizedSinceFrame = true
    this.renderer.setSize(width, height, false)
    this.post?.setSize(width, height)
    this.rig.setViewport(width, height)
    this.updateNodeLod() // viewport height changed → projected sizes changed
    this.requestRender()
  }

  /**
   * Export the live board as a PNG at the CURRENT camera framing.
   *
   * Renders one frame at `scale`× the CSS size (clamped to a safe max edge for
   * supersampling), then snapshots the drawing buffer with `toDataURL` in the
   * SAME synchronous task — the reliability guarantee the readPixel probe leans
   * on, so it works even though the renderer keeps `preserveDrawingBuffer`
   * false. The live pixel ratio + a repaint are restored before returning, so
   * the on-screen board is untouched. Aspect is unchanged (same CSS size), so
   * the camera needs no update.
   */
  capturePng(scale = 2): Blob {
    const css = this.renderer.getSize(new THREE.Vector2())
    const maxEdge = 8192
    const ratio = Math.max(
      1,
      Math.min(scale, maxEdge / Math.max(1, css.x), maxEdge / Math.max(1, css.y)),
    )
    const prevRatio = this.renderer.getPixelRatio()
    this.renderer.setPixelRatio(ratio) // three re-applies the drawing-buffer size
    this.post?.setSize(css.x, css.y) // composer targets track the new buffer size
    this.scene.updateMatrixWorld()
    for (const b of this.billboards) b.quaternion.copy(this.rig.camera.quaternion)
    this.renderFrame()
    const dataUrl = this.canvas.toDataURL('image/png')
    this.renderer.setPixelRatio(prevRatio)
    this.post?.setSize(css.x, css.y)
    this.resizedSinceFrame = true
    this.requestRender()

    const comma = dataUrl.indexOf(',')
    const bin = atob(dataUrl.slice(comma + 1))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: 'image/png' })
  }

  setSkin(skin: SkinConfig): void {
    this.skin = skin
    this.palette = resolve3dPalette(skin)
    this.applyEnvironment()
    this.buildSignature = ''
    this.rebuild()
  }

  setResolvedTheme(theme: 'light' | 'dark'): void {
    if (theme === this.resolvedTheme) return
    this.resolvedTheme = theme
    this.buildSignature = ''
    this.rebuild()
  }

  /** Install the theme's 3D surface — spec builders, environment,
   * pixel-snap. Resolved by the host via `plugins/theme3d.themeFor3d`. */
  setTheme3d(theme: Theme3dSource | null): void {
    const themeChanged = theme?.themeId !== this.theme3d?.themeId
    // theme flip drops the previous theme's decoded assets (GPU memory)
    if (this.theme3d && themeChanged) {
      disposeThemeAssets()
      this.floorMapClone?.clone.dispose()
      this.floorMapClone = null
    }
    if (themeChanged) {
      this.voxelTransient.clear()
      this.voxelAnimations.clear()
      this.hoveredVoxelId = null
    }
    this.theme3d = theme
    this.applyEnvironment()
    this.buildSignature = ''
    this.rebuild()
  }

  /** The single render choke point — every pixel this engine produces flows
   * through here (loop, probes, capture), so the lit post stack can slot a
   * composer in without touching call sites. */
  private renderFrame(): void {
    if (this.firstFramePending) {
      // perf probe: the first frame after a full build pays program compiles
      // and texture uploads — measure it, it is the visible hitch
      this.firstFramePending = false
      const t0 = performance.now()
      this.renderFrameInner()
      this.buildTimings.firstFrameMs = performance.now() - t0
    } else {
      this.renderFrameInner()
    }
    // the new build now holds every program it draws with (including the
    // shadow-depth variants acquired by this frame) — the old build's
    // materials can go without taking a shared program down with them
    this.flushRetiredMaterials()
  }

  private renderFrameInner(): void {
    if (this.shadowsDirty) {
      // autoUpdate is off under the lit profile (see requestCameraRender);
      // three clears needsUpdate itself after re-rendering the map
      this.renderer.shadowMap.needsUpdate = true
      this.shadowsDirty = false
    }
    if (this.postFirstRenderPending) {
      // perf probe: which programs did the first frame of this build (or of
      // the freshly mounted post stack) still have to link? Each one is a
      // synchronous stall the warm-up missed. The shadow pass split ahead of
      // it (primeShadowPass) already took the `before` snapshot, so its links
      // are counted here too.
      this.postFirstRenderPending = false
      const before = this.postFirstBefore ?? new Set<unknown>(this.renderer.info.programs ?? [])
      this.postFirstBefore = null
      this.postFirstPriorPrograms = (this.renderer.info.programs ?? [])
        .filter((p) => before.has(p))
        .map((p) => `${p.name}|${p.cacheKey}`)
      const t0 = performance.now()
      this.renderComposed()
      this.buildTimings.postFirstMs = performance.now() - t0
      this.buildTimings.postFirstBuild = this.buildTimings.builds
      this.buildTimings.postFirstComposed = this.post !== null
      this.postFirstNewPrograms = (this.renderer.info.programs ?? [])
        .filter((p) => !before.has(p))
        .map((p) => `${p.name}|${p.cacheKey}`)
      return
    }
    this.renderComposed()
  }

  private renderComposed(): void {
    this.updateInkUniforms()
    this.updateEditHandles()
    this.updateInkBeads()
    if (this.post) {
      this.post.render()
      return
    }
    this.renderer.render(this.scene, this.rig.camera)
  }

  /** Arm the first-frame probe for a new program set (a full build or a post
   * stack swap) — nothing of the previous measurement is carried over. */
  private armFirstFrameProbe(): void {
    this.postFirstRenderPending = true
    this.postFirstBefore = null
    this.postFirstNewPrograms = []
    this.postFirstPriorPrograms = []
    this.buildTimings.postFirstMs = 0
    this.buildTimings.postFirstShadowMs = 0
    this.buildTimings.postFirstBuild = -1
    this.buildTimings.postFirstComposed = false
  }

  /** Render the shadow map ALONE, in its own task, ahead of the first
   * composed frame of a build / post-stack swap.
   *
   * The shadow pass (every caster into a 2-4k depth map) and the composed
   * pass (scene + AO + bloom at DPR 2) used to share one task: enter-3D at
   * DPR 2 measured a 216 ms long task (loop1-r2-dpr2, gate 200). Split, each
   * is its own task and the composed frame finds the map already current.
   *
   * How: three renders shadow maps only inside `renderer.render`, from each
   * light's own shadow camera — the main camera only gates LAYERS. A camera
   * with the main camera's layers but a frustum that contains nothing culls
   * every frustum-culled object from the main pass (the clip-space backdrop
   * still draws, one quad), while the shadow pass renders every caster. It
   * draws into the composer's scene buffer, which the composed frame clears
   * and redraws, so every program key matches the RenderPass's — nothing new
   * is linked. Returns false when there is nothing to prime. */
  private primeShadowPass(): boolean {
    const sm = this.renderer.shadowMap
    if (!this.post || !sm.enabled || !(this.shadowsDirty || sm.needsUpdate)) return false
    sm.needsUpdate = true
    this.shadowsDirty = false
    const cam = (this.shadowPrimeCamera ??= new THREE.PerspectiveCamera(1, 1, 1, 2))
    cam.layers.mask = this.rig.camera.layers.mask
    // far below the floor, looking further down, a 1-unit-deep frustum
    cam.position.set(0, -1e6, 0)
    cam.lookAt(0, -2e6, 0)
    cam.updateMatrixWorld()
    if (this.postFirstRenderPending && !this.postFirstBefore) {
      this.postFirstBefore = new Set<unknown>(this.renderer.info.programs ?? [])
    }
    const prev = this.renderer.getRenderTarget()
    const t0 = performance.now()
    try {
      this.renderer.setRenderTarget(this.post.sceneTarget)
      this.renderer.render(this.scene, cam)
    } finally {
      this.renderer.setRenderTarget(prev)
    }
    if (this.postFirstRenderPending) this.buildTimings.postFirstShadowMs = performance.now() - t0
    return true
  }

  /** Auto-degrade governor, fed by FRAME PACING: the interval between two
   * consecutively rendered rAF frames. Sustained slow pacing walks the lit
   * tier down (high → medium → low), then the pixel ratio (→ 1.5 → 1), never
   * back up — a stutter on entry is fine, a permanently sluggish board is not.
   *
   * It used to time `post.render()` on the CPU. That call returns once the
   * commands are SUBMITTED; on a GPU-bound laptop it stays a few ms while
   * the frames themselves take 40+, so the governor could never fire where
   * it was needed. Pacing includes the GPU's back-pressure.
   *
   * …but NOT the wait for input. A drag renders on pointer moves, so the
   * interval between two drag frames also contains however long the next
   * pointer event took to arrive — time during which no frame was even
   * requested. That gap is subtracted (`rafRequestedAt − lastTickEnd`): what
   * remains is the previous frame's own work plus the wait from request to
   * rAF, which is exactly where GPU back-pressure shows. Measured before the
   * fix (scripts/view3d-quality + an orbit profile, 2026-10-08, RTX 4080 at
   * 3 ms/frame): a scripted mouse orbit fed input-paced 21-31 ms intervals,
   * the EMA crossed 26 ms on the city board, and the governor dropped the
   * tier MID-ORBIT — a full rebuild (city, slabs, decor placement) plus a
   * post-stack swap — which IS the 82-100 ms "orbit hitch". */
  /** Display refresh interval, measured once on empty rAF ticks (no GPU work
   * queued, so the interval is the panel's pacing, not ours). The MINIMUM
   * over the window: a busy tick can only lengthen an interval. */
  private vsyncMs = 1000 / 60

  private measureVsync(): void {
    let last = 0
    let n = 0
    let min = Infinity
    const tick = (t: number) => {
      if (this.disposed) return
      if (last) min = Math.min(min, t - last)
      last = t
      if (++n < 12) requestAnimationFrame(tick)
      else if (Number.isFinite(min) && min > 2) this.vsyncMs = min
    }
    requestAnimationFrame(tick)
  }

  private governFramePacing(now: number): void {
    const last = this.lastRenderAt
    this.lastRenderAt = now
    // last === 0: the previous tick did not render or the loop went idle, so
    // this interval is not a frame time. Capped so one hidden-tab gap cannot
    // swing the average on its own.
    if (this.renderProfile !== 'lit' || last === 0) return
    const inputWait = Math.max(0, this.rafRequestedAt - this.lastTickEnd)
    const dt = Math.min(250, Math.max(0, now - last - inputWait))
    this.frameCostEma = this.frameCostEma === 0 ? dt : this.frameCostEma * 0.9 + dt * 0.1
    // "slow" is relative to what the DISPLAY can deliver: a 30 Hz panel or
    // Chrome's energy saver paces every frame at ~33 ms on an idle GPU, which
    // an absolute 26 ms threshold read as overload and walked the quality
    // down to nothing (review 2026-10-08)
    if (this.frameCostEma <= Math.max(GOVERNOR_SLOW_MS, this.vsyncMs * 1.6)) {
      this.slowFrames = 0
      return
    }
    if (++this.slowFrames < GOVERNOR_SLOW_FRAMES) return
    this.slowFrames = 0
    this.frameCostEma = 0
    if (this.qualityTier !== 'low') {
      this.setQualityTier(this.qualityTier === 'high' ? 'medium' : 'low')
      return
    }
    const pr = this.renderer.getPixelRatio()
    if (pr > 1) {
      this.renderer.setPixelRatio(Math.max(1, pr - 0.5))
      const size = this.renderer.getSize(new THREE.Vector2())
      this.post?.setSize(size.x, size.y)
      this.resizedSinceFrame = true
      this.requestRender()
    }
  }

  /** Flip the renderer/scene between the unlit and lit profiles from the
   * active theme's sanitized `environment.lighting` block (PBR migration).
   * Rig + IBL are created once per profile ACTIVATION — rebuilds never churn
   * them (the leak-plateau drills are the gate). `forceEnvRefresh` regenerates
   * the PMREM texture after a GL context restore (render-target textures do
   * not survive the restore). */
  private applyRenderProfile(opts: { forceEnvRefresh?: boolean } = {}): void {
    const lighting = this.theme3d?.environment?.lighting ?? null
    if (lighting) {
      this.renderer.toneMapping =
        lighting.toneMapping === 'neutral' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping
      this.renderer.toneMappingExposure = lighting.exposure ?? 1.1
      this.renderer.shadowMap.enabled = lighting.shadows?.enabled !== false
      // PCFShadowMap, NOT PCFSoftShadowMap: three r185 deprecates the soft
      // type and rewrites it to PCF inside the FIRST shadow render — after
      // every precompile, so each lit program was keyed on the wrong shadow
      // type and linked again, synchronously, on the first frame (26 programs,
      // 1.1 s, perfInfo().postFirstNewPrograms 2026-10-08). r185's PCF is the
      // soft variant the old type asked for.
      this.renderer.shadowMap.type = THREE.PCFShadowMap
      // re-rendered only when a caster may have changed (shadowsDirty)
      this.renderer.shadowMap.autoUpdate = false
      this.shadowsDirty = true
      this.litRig = mountLightRig(this.scene, this.litRig, lighting)
      this.mountPracticalSpot()
      if (this.renderProfile !== 'lit') {
        // entering the lit profile: pick the starting tier once — software
        // rasterizers (SwiftShader CI, VMs) never get the AO pass by default
        this.qualityTier = this.detectDefaultTier()
        this.frameCostEma = 0
        this.slowFrames = 0
      }
      if (opts.forceEnvRefresh) {
        // GL context restore: composer targets died with the old context
        this.disposePost()
      }
      if (opts.forceEnvRefresh && this.litEnvHeld) {
        releaseRoomEnvironment(this.renderer)
        this.litEnvHeld = false
        this.envSeq++
        this.scene.environment = null
      }
      if (!this.litEnvHeld) {
        // Built off the critical path (acquireRoomEnvironmentAsync). The
        // environment is part of every lit program's key, so the compile gate
        // waits for it (scheduleCompile) — nothing is linked twice and no frame
        // is drawn without it.
        this.litEnvHeld = true
        const seq = ++this.envSeq
        this.envPending = acquireRoomEnvironmentAsync(this.renderer)
          .then((texture) => {
            if (seq !== this.envSeq || this.disposed) return
            this.scene.environment = texture
          })
          .catch(() => {
            /* no IBL: the rig's sun + hemisphere still light the board */
          })
          .finally(() => {
            if (seq === this.envSeq) this.envPending = null
          })
        this.scheduleCompile()
      }
      this.scene.environmentIntensity = lighting.ibl?.intensity ?? 0.35
      this.renderProfile = 'lit'
      this.ensurePost()
    } else {
      this.renderer.toneMapping = THREE.NoToneMapping
      this.renderer.toneMappingExposure = 1
      this.renderer.shadowMap.enabled = false
      this.renderer.shadowMap.autoUpdate = true
      disposeLightRig(this.scene, this.litRig)
      this.litRig = null
      this.unmountPracticalSpot()
      if (this.litEnvHeld) {
        releaseRoomEnvironment(this.renderer)
        this.litEnvHeld = false
        this.envSeq++
        this.envPending = null
      }
      this.scene.environment = null
      this.scene.environmentIntensity = 1
      this.renderProfile = 'unlit'
      this.disposePost()
      this.qualityTier = 'high'
    }
  }

  /** The lit profile's practical lamp light, mounted ONCE per activation and
   * parked at intensity 0 when the background has no lamp.
   *
   * three keys every lit program on the scene's light counts, so a SpotLight
   * that came and went with the workbench background recompiled EVERY lit
   * material on each background switch (35 programs, 983 ms of main-thread
   * link on an RTX 4080 — scripts/view3d-quality, 2026-10-08). A constant
   * light set keeps the programs; only uniforms change. */
  private practicalSpot: THREE.SpotLight | null = null

  private mountPracticalSpot(): void {
    if (this.practicalSpot) return
    const spot = new THREE.SpotLight(0xffffff, 0, 0, 0.43, 0.5, 0)
    spot.castShadow = false
    spot.name = 'practical-spot'
    this.scene.add(spot, spot.target)
    this.practicalSpot = spot
  }

  private unmountPracticalSpot(): void {
    const spot = this.practicalSpot
    if (!spot) return
    this.scene.remove(spot, spot.target)
    spot.dispose()
    this.practicalSpot = null
  }

  /** Software rasterizers start at 'medium' (no AO pass) — N8AO on a CPU
   * raster is the one genuinely unaffordable effect; real GPUs start 'high'
   * and the auto-degrade governor can still walk them down. */
  private detectDefaultTier(): QualityTier {
    try {
      const gl = this.renderer.getContext()
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
      return /swiftshader|software|llvmpipe/i.test(gpu) ? 'medium' : 'high'
    } catch {
      return 'medium'
    }
  }

  /** Load the post chunk + build the composer for the current tier. Nested
   * lazy: unlit users never download `postprocessing`/`n8ao`; until the chunk
   * resolves the lit scene renders composer-less (lights/shadows already
   * correct — no black frame, no blocking). */
  private ensurePost(): void {
    if (this.disposed || this.qualityTier === 'low') return
    if (this.post || this.postLoading) return
    const lighting = this.theme3d?.environment?.lighting
    if (!lighting) return
    this.postLoading = true
    void import('./lit/post')
      .then((m) => {
        this.postLoading = false
        if (this.disposed || this.renderProfile !== 'lit' || this.qualityTier === 'low') return
        const lit = this.theme3d?.environment?.lighting
        if (!lit) return
        // What this stack is FOR: a tier change, a lighting swap or a context
        // restore while it warms (seconds on a cold GPU) makes it the wrong
        // stack, and it must not be installed (review 2026-10-08)
        const gen = this.postGen
        const tier = this.qualityTier
        const size = this.renderer.getSize(new THREE.Vector2())
        const stack = m.createPostStack(this.renderer, this.scene, this.rig.camera, lit, tier as Exclude<QualityTier, 'low'>)
        stack.setSize(size.x, size.y)
        // Keep rendering composer-less until every program the composed frame
        // needs is linked — swapping the stack in cold froze the main thread
        // for ~1 s on the first composed frame (see compileSceneFor).
        this.postLoading = true
        const ceiling = new Promise<void>((r) => setTimeout(r, COMPILE_GATE_MAX_MS))
        const warmed = (this.envPending ?? Promise.resolve()).then(() => this.compileSceneFor(stack, true))
        return Promise.race([warmed, ceiling]).then(() => {
          this.postLoading = false
          const stale = gen !== this.postGen || tier !== this.qualityTier || this.theme3d?.environment?.lighting !== lit
          if (this.disposed || this.renderProfile !== 'lit' || this.qualityTier === 'low' || this.post || stale) {
            stack.dispose()
            // superseded, not cancelled: build the stack the scene wants NOW
            if (stale && !this.disposed && !this.post) this.ensurePost()
            return
          }
          this.post = stack
          // the passes' programs are linked: introspect them between frames
          this.settlePrograms()
          this.armFirstFrameProbe()
          this.composerPassCount = stack.passCount
          // the scene may have changed key-relevant state while the stack
          // warmed (the enter morph turns the floor transparent) — gate the
          // first composed frame on THAT state's programs, not the warm-time one
          this.scheduleCompile()
          this.requestRender()
        })
      })
      .catch(() => {
        // chunk load failure (offline dev, CSP): stay composer-less — the lit
        // scene is still fully usable, AO/bloom are enhancement layers
        this.postLoading = false
      })
  }

  /** Bumped whenever the current stack is torn down — a stack still warming
   * from before that point is stale (ensurePost). */
  private postGen = 0

  private disposePost(): void {
    this.postGen++
    this.post?.dispose()
    this.post = null
    this.composerPassCount = 0
  }

  /** Host/probe: force a post quality tier (never auto-upgraded back). */
  setQualityTier(tier: QualityTier): void {
    if (tier === this.qualityTier) return
    const wasHigh = this.qualityTier === 'high'
    this.qualityTier = tier
    this.frameCostEma = 0
    this.slowFrames = 0
    this.disposePost()
    if (this.renderProfile === 'lit' && tier !== 'low') this.ensurePost()
    // frosted card walls are REAL transmission only on 'high' — crossing the
    // boundary swaps wall materials via a one-time full rebuild (the
    // governor only ever descends, so this fires at most once per session)
    if (this.renderProfile === 'lit' && wasHigh !== (tier === 'high')) {
      this.buildSignature = ''
      this.rebuild()
    }
    this.requestRender()
  }

  /** Scene background + fog from the environment block (skin bg when absent). */
  private applyEnvironment(): void {
    if (!this.skin) return
    const env = this.theme3d?.environment ?? null
    this.env3d = env
    this.applyRenderProfile()
    const baseBg = colorAlpha(this.skin.canvas.bg).color
    // the gradient branch re-shows it; every other background hides it
    if (this.backdrop) setBackdropTexture(this.backdrop, null)
    if (env?.background && typeof env.background === 'object') {
      if ('asset' in env.background) {
        // equirect sky from meta.assets: base color first, texture when decoded
        this.scene.background = new THREE.Color(baseBg)
        this.withAssetTexture(env.background.asset, (tex) => {
          if (this.env3d !== env) return // theme moved on while decoding
          tex.mapping = THREE.EquirectangularReflectionMapping
          if (this.theme3d?.pixelSnap != null) {
            // low-res pixel-art sky: crisp texels, no linear smear
            tex.magFilter = THREE.NearestFilter
            tex.needsUpdate = true
          }
          this.scene.background = tex
          this.requestRender()
        })
      } else {
        // A scene-owned mesh, not `scene.background`: three's background
        // quad is in no scene, so the async compile gate never linked its
        // program and the first frame did, synchronously (backdrop.ts).
        // The clear color under it is the base color, as before the texture
        // was decoded.
        this.scene.background = new THREE.Color(baseBg)
        if (!this.backdrop) {
          this.backdrop = createGradientBackdrop()
          this.scene.add(this.backdrop)
        }
        setBackdropTexture(this.backdrop, gradientTexture(env.background.top, env.background.bottom), this.scene.backgroundIntensity)
      }
    } else {
      const css = typeof env?.background === 'string' ? colorAlpha(env.background).color : baseBg
      this.scene.background = new THREE.Color(css)
    }
    if (env?.fog) {
      const fog = new THREE.FogExp2(0xffffff, env.fog.density)
      // Raw-sRGB trick (see srgbUniform): our custom shaders output raw sRGB,
      // so the fog color must bypass the working-space conversion too.
      fog.color.setStyle(colorAlpha(env.fog.color ?? baseBg).color, THREE.LinearSRGBColorSpace)
      this.scene.fog = fog
    } else {
      this.scene.fog = null
    }
    this.requestRender()
  }

  setReadonly(v: boolean): void {
    this.readonly_ = v
  }

  private rawFloorMap(src: THREE.Texture): THREE.Texture {
    if (this.floorMapClone?.src === src) return this.floorMapClone.clone
    this.floorMapClone?.clone.dispose()
    const t = src.clone()
    t.colorSpace = THREE.LinearSRGBColorSpace // raw passthrough (see srgbUniform)
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
    // pixel-snap themes author chunky low-res tiles — sample them as crisp
    // texels, not a linear blur (part of the pixelSnap free-inheritance layer)
    if (this.theme3d?.pixelSnap != null) t.magFilter = THREE.NearestFilter
    t.needsUpdate = true
    this.floorMapClone = { src, clone: t }
    return t
  }

  /** Pixel-snap themes force sharp corners on the board dressing (platform
   * plates, tags, pills, tiles) — the 3D face of the 2D sharp-corner rule. */
  private pxr(r: number): number {
    return this.theme3d?.pixelSnap != null ? 0 : r
  }

  /** Resolve a `meta.assets` TEXTURE by id: apply immediately when decoded,
   * else kick the (cached) decode and apply when it lands. Returns whether the
   * id names a declared texture asset at all. */
  private withAssetTexture(assetId: string, apply: (tex: THREE.Texture) => void): boolean {
    const theme = this.theme3d
    const decl = theme?.assets?.[assetId]
    if (!theme || !decl || decl.kind !== 'texture') return false
    const entry = getLoadedAsset(theme.themeId, assetId)
    if (entry?.texture) {
      apply(entry.texture)
      return true
    }
    if (entry === null) return false // decode failed earlier — derived look
    void loadThemeAsset(theme.themeId, assetId, decl).then((e) => {
      if (!this.disposed && this.theme3d === theme && e?.texture) apply(e.texture)
    })
    return true
  }

  /**
   * Mount a spec's custom BODY: a camera-facing billboard plane or
   * a sanitized GLTF model, fitted to the node's footprint and grounded at
   * `baseY`. Returns the lifted top height, or null to keep the default body
   * (asset missing / still decoding — the decode triggers a rebuild — or
   * rejected by the caps). Cloned asset meshes share the cached template's
   * geometry/materials, so they carry `sharedAsset` and the teardown paths
   * must NOT dispose them.
   */
  private tryAssetBody(unit: THREE.Group, o: C4Object, spec: NodeSpec3D, baseY: number): number | null {
    const theme = this.theme3d
    if (!spec.geometry || !spec.asset || !theme?.assets) return null
    const decl = theme.assets[spec.asset]
    if (!decl) return null
    const entry = getLoadedAsset(theme.themeId, spec.asset)
    if (entry === undefined) {
      void loadThemeAsset(theme.themeId, spec.asset, decl).then((e) => {
        if (e && !this.disposed) {
          this.buildSignature = ''
          this.rebuild()
        }
      })
      return null // real default body until the decode lands — never a stub
    }
    if (entry === null) return null
    const w = o.size.width
    const h = o.size.height
    const s = spec.scale ?? 1

    if (spec.geometry === 'billboard' && entry.kind === 'texture' && entry.texture) {
      const img = entry.texture.image as { width: number; height: number }
      const bw = w * s
      const bh = bw * (img.height / Math.max(1, img.width))
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(bw, bh),
        new THREE.MeshBasicMaterial({ map: entry.texture, transparent: true, side: THREE.DoubleSide, toneMapped: false }),
      )
      plane.position.set(w / 2, baseY + bh / 2, h / 2)
      plane.userData.pick = { kind: 'object', id: o.id } satisfies PickTarget
      plane.userData.assetBody = spec.asset // dev-probe marker
      this.pickables.push(plane)
      this.billboards.push(plane)
      unit.add(plane)
      return baseY + bh
    }

    if (spec.geometry === 'gltf' && entry.kind === 'gltf' && entry.object) {
      const clone = entry.object.clone(true)
      const bb = new THREE.Box3().setFromObject(clone)
      const size = new THREE.Vector3()
      bb.getSize(size)
      const fit = Math.min(w / Math.max(1e-6, size.x), h / Math.max(1e-6, size.z)) * s
      clone.scale.setScalar(fit)
      const center = new THREE.Vector3()
      bb.getCenter(center)
      clone.position.set(w / 2 - center.x * fit, baseY - bb.min.y * fit, h / 2 - center.z * fit)
      clone.userData.assetBody = spec.asset // dev-probe marker
      clone.traverse((m) => {
        if ((m as THREE.Mesh).isMesh) {
          m.userData.pick = { kind: 'object', id: o.id } satisfies PickTarget
          m.userData.sharedAsset = true // geometry/material owned by the cache
          this.pickables.push(m)
        }
      })
      unit.add(clone)
      return baseY + (bb.max.y - bb.min.y) * fit
    }

    return null
  }

  setData(
    objects: C4Object[],
    connections: Connection[],
    groups: Group[],
    tags: Tag[] = [],
    extras?: { expandableIds?: string[] },
  ): void {
    this.expandableIds = new Set(extras?.expandableIds ?? [])
    this.data = { objects, connections, groups, tags }
    this.refreshTagFocusMembership()
    this.rebuild()
  }

  /** Lower the projected-size LOD cut-offs (Model Viewer: names are the point
   * of the page, keep them further out than the editor's defaults). */
  setLodThresholds(primaryPx: number, secondaryPx: number): void {
    this.lodPrimaryPx = primaryPx
    this.lodSecondaryPx = secondaryPx
    this.updateNodeLod()
  }

  setBottomTab(tab: BottomBarTab): void {
    if (tab === this.bottomTab) return
    this.bottomTab = tab
    this.buildSignature = ''
    this.rebuild()
  }

  setActiveTagGroup(groupId: string | null): void {
    if (groupId === this.activeTagGroupId) return
    this.activeTagGroupId = groupId
    this.buildSignature = ''
    this.rebuild()
  }

  setTagInteractions(
    hoveredTagId: string | null,
    pinnedTagIds: string[],
    focusedTagId: string | null,
    hiddenTagIds: string[],
  ): void {
    const samePins = pinnedTagIds.length === this.pinnedTagIds.length
      && pinnedTagIds.every((tagId, index) => tagId === this.pinnedTagIds[index])
    const sameHidden = hiddenTagIds.length === this.hiddenTagIds.size
      && hiddenTagIds.every((tagId) => this.hiddenTagIds.has(tagId))
    if (
      hoveredTagId === this.hoveredTagId
      && focusedTagId === this.focusedTagId
      && samePins
      && sameHidden
    ) return
    this.hoveredTagId = hoveredTagId
    this.pinnedTagIds = [...pinnedTagIds]
    this.focusedTagId = focusedTagId
    this.hiddenTagIds = new Set(hiddenTagIds)
    this.buildSignature = ''
    this.rebuild()
  }

  setManagedPerspectiveInteractions(
    kind: ManagedPerspective,
    hoveredId: string | null,
    pinnedIds: string[],
    focusedId: string | null,
    hiddenIds: string[],
  ): void {
    const current = this.managedPerspectiveInteractions[kind]
    const samePins = pinnedIds.length === current.pinnedIds.length
      && pinnedIds.every((id, index) => id === current.pinnedIds[index])
    const sameHidden = hiddenIds.length === current.hiddenIds.size
      && hiddenIds.every((id) => current.hiddenIds.has(id))
    if (hoveredId === current.hoveredId && focusedId === current.focusedId && samePins && sameHidden) return
    this.managedPerspectiveInteractions[kind] = {
      hoveredId,
      pinnedIds: [...pinnedIds],
      focusedId,
      hiddenIds: new Set(hiddenIds),
    }
    if (this.bottomTab === kind) {
      this.buildSignature = ''
      this.rebuild()
    }
  }

  /** Install the diagram's scene decoration (sanitized upstream — decor is a
   * per-diagram SHARED setting riding the Automerge doc like skinId). */
  setSceneDecor(decor: SceneDecor3D | null): void {
    const next = decor ? JSON.stringify(decor) : ''
    const prev = this.sceneDecor ? JSON.stringify(this.sceneDecor) : ''
    if (next === prev) return
    this.sceneDecor = decor
    this.buildSignature = ''
    // The rebuild runs on the next frame, not inside the store change: a
    // decor pick arrives inside the menu's click, and the click's React
    // commit + this rebuild made ONE long task (137-142 ms against the 150
    // budget, loop4-r5 / me-prof2: dispatchDiscreteEvent 135 ms). Split,
    // each half is its own task. Coalesced: several changes in one frame
    // rebuild once. The readiness probe stays honest via decorRebuildRaf.
    if (this.decorRebuildRaf !== null) return
    this.decorRebuildRaf = requestAnimationFrame(() => {
      this.decorRebuildRaf = null
      if (this.disposed) return
      // a full rebuild in between (setData on mount) already used this decor
      if (this.buildSignature !== '') return
      this.rebuild()
    })
  }
  /** Pending deferred decor rebuild (setSceneDecor). */
  private decorRebuildRaf: number | null = null

  setShowGrid(show: boolean): void {
    if (show === this.showGrid) return
    this.showGrid = show
    const t = this.floorGridToggle
    if (t) t.uniform.value = show ? t.on : t.off
    this.applyLitGridMap()
    this.requestRender()
  }

  /** The lit cap's map for the grid toggle and the drag state — a texture
   * ref swap on the same program (every map is the same size and format). */
  private applyLitGridMap(): void {
    const lg = this.litFloorGrid
    if (!lg) return
    const want = !this.showGrid ? lg.off : this.gridDragging ? lg.drag : lg.on
    if (lg.mat.map === want) return
    lg.mat.map = want
    lg.mat.needsUpdate = false
    // the map is not a shadow input
    this.requestCameraRender()
  }

  /** Drag start/end (pointer handlers): the board shows its full pitch —
   * the 20-unit minors a card snaps to — only while something moves. */
  private setGridDragging(on: boolean): void {
    if (this.gridDragging === on) return
    this.gridDragging = on
    this.applyLitGridMap()
  }

  setSelection(ids: string[]): void {
    const next = new Set(ids)
    if (next.size === this.selectedIds.size && [...next].every((id) => this.selectedIds.has(id))) return
    this.selectedIds = next
    // Every card, drum and platform carries its own selected flag in
    // dataSignature, so a change that leaves the signature alone touched
    // only connections (their highlight and focus dim): rebuild those. The
    // full rebuild here re-made every card, the floor and the decor and
    // re-compiled the scene for a click on a cable — 611-690 ms per
    // selection click on 0ob3fum (profiled: buildCard 112, warmDraw /
    // compileSceneFor 165-180, connect-freeze 2026-10-11).
    if (this.skin && this.palette && this.batchDepth === 0 && this.buildSignature !== '' && this.dataSignature() === this.buildSignature) {
      this.buildConnections()
      return
    }
    this.buildSignature = ''
    this.rebuild()
  }

  setConnectionHighlightStyle(style: ConnectionHighlightStyle): void {
    if (style === this.highlightStyle) return
    this.highlightStyle = style
    if (this.skin) this.buildConnections()
  }

  setConnectionAnimationsEnabled(enabled: boolean): void {
    if (enabled === this.connAnimationsEnabled) return
    this.connAnimationsEnabled = enabled
    if (this.skin) this.buildConnections()
  }

  setCameraPreset(preset: CameraPresetId): void {
    this.preset = preset
    this.buildSignature = ''
    this.rebuild()
    this.rig.goToPreset(preset, this.contentBounds(), false)
  }

  getPreset(): CameraPresetId {
    return this.preset
  }

  /** Frame the content at the active preset. `intro` runs the enter morph from
   * a top-down pose over the preset's own framing (the no-2D-viewport case). */
  frame(intro = false, insets?: CameraViewportInsets): void {
    if (intro) this.enterMorph(null)
    else if (insets || this.safeAreaProvider) {
      // fit-to-screen: every node's projected 3D box inside the canvas minus
      // the floating chrome. The host's measured insets win where they are
      // larger than the caller's nominal panel widths (CanvasView passes a
      // fixed 340 per open side panel and nothing for the toolbars).
      const measured = this.safeAreaProvider?.() ?? {}
      const side = (k: keyof CameraViewportInsets) => Math.max(insets?.[k] ?? 0, measured[k] ?? 0)
      const safe = { left: side('left'), right: side('right'), top: side('top'), bottom: side('bottom') }
      // the desk showcase is aimed at THIS framing (buildDecor): when the
      // chrome moved since the decor was placed, re-place it
      const prev = this.lastFitInsets
      this.lastFitInsets = safe
      if (prev && (['left', 'right', 'top', 'bottom'] as const).some((k) => Math.abs(prev[k] - safe[k]) > 8)) {
        this.scheduleDecorRefresh()
      }
      const points = this.nodeFitBoxes().flatMap((b) => b.corners)
      if (points.length > 0) this.rig.goToPresetFitting(this.preset, this.contentBounds(), points, safe, false)
      else this.rig.goToPresetWithInsets(this.preset, this.contentBounds(), safe, false)
    } else this.rig.goToPreset(this.preset, this.contentBounds(), false)
  }

  /** The host measures what overlays the canvas (Canvas3DView: side panels,
   * tool pill, bottom toolbars — their DOMRects) at fit time. */
  setSafeAreaProvider(provider: (() => CameraViewportInsets) | null): void {
    this.safeAreaProvider = provider
  }

  /** A drum's floor tag rect in board coords (storeTagRect at the preset's
   * azimuth), or null. */
  private storeTag(o: C4Object, r: Rect): Box | null {
    const tag = this.storeTagLocal.get(o.id) ?? storeTagRect(o, { x: 0, y: 0, w: r.w, h: r.h }, CAMERA_PRESETS[this.preset].rz, DRUM_R)
    return tag ? { ...tag, x: tag.x + r.x, y: tag.y + r.y } : null
  }

  /** Each drum's floor-tag rect as BUILT, relative to the drum's node origin
   * (a positions-only move carries the tag with its drum, so every consumer
   * keeps reading the rect the standee drew). */
  private storeTagLocal = new Map<string, Box>()

  /** Place every drum's name tag at a full build: in front of its drum
   * (storeTagRect), slid sideways off any card's on-screen footprint
   * (screenShadowOnFloor + slideClear). The NAME tag (restored on the user's
   * decision of 2026-10-10) is wider than the technology tag it replaced:
   * 'Event bus' touched Rollup worker by 0.7 px on screen in
   * tp4-cards/workbench-tag-0.png. */
  private placeStoreTags(): void {
    this.storeTagLocal.clear()
    const preset = CAMERA_PRESETS[this.preset]
    const cards = this.data.objects
      .filter((c) => c.type !== 'store')
      // the slab and, under the lit profile, its 7-unit plinth rim
      .map((c) => screenShadowOnFloor({ x: c.position.x, y: c.position.y, w: c.size.width, h: c.size.height }, preset.depth, preset.rx, preset.rz, 8))
    for (const o of this.data.objects) {
      if (o.type !== 'store') continue
      const local = storeTagRect(o, { x: 0, y: 0, w: o.size.width, h: o.size.height }, preset.rz, DRUM_R)
      if (!local) continue
      const board = { ...local, x: local.x + o.position.x, y: local.y + o.position.y }
      const slid = slideClear(board, preset.rz, cards, 4, 80)
      this.storeTagLocal.set(o.id, { ...local, x: slid.x - o.position.x, y: slid.y - o.position.y })
    }
  }

  /** Each node's 3D box as 8 world-space corners: the card slab (+ the lit
   * plinth rim) from its base to its top face; the drum from its pad to its
   * lid, widened to the pad ring and reaching forward to the name tag. */
  private nodeFitBoxes(): { id: string; corners: { x: number; y: number; z: number }[] }[] {
    const out: { id: string; corners: { x: number; y: number; z: number }[] }[] = []
    const box = (id: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
      const corners: { x: number; y: number; z: number }[] = []
      for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) corners.push({ x, y, z })
      out.push({ id, corners })
    }
    for (const o of this.data.objects) {
      const unit = this.nodeGroups.get(o.id)
      if (!unit) continue // hidden by a tag perspective: nothing to frame
      const baseY = (unit.userData.baseY as number | undefined) ?? 0
      const r = this.objectRect(o)
      if (o.type === 'store') {
        const cx = r.x + r.w / 2
        const cz = r.y + r.h / 2
        const tag = this.storeTag(o, r)
        const lidY = baseY + DRUM_H + (this.selectedIds.has(o.id) ? SELECTED_LIFT * 0.5 : 0)
        box(
          o.id,
          Math.min(cx - PAD_R, tag?.x ?? Infinity),
          Math.max(cx + PAD_R, tag ? tag.x + tag.w : -Infinity),
          baseY,
          lidY,
          Math.min(cz - PAD_R, tag?.y ?? Infinity),
          Math.max(cz + PAD_R, tag ? tag.y + tag.h : -Infinity),
        )
      } else {
        const topY = (unit.userData.topY as number | undefined) ?? baseY + CAMERA_PRESETS[this.preset].depth
        box(o.id, r.x - 7, r.x + r.w + 7, baseY, topY, r.y - 7, r.y + r.h + 7)
      }
    }
    return out
  }

  /** Each node's SOLIDS as world points (quality pass "labels"): a card's
   * slab from its base to its top face plus the lit plinth rim (7 px out,
   * 2.6 tall); a drum's body (16 points round its foot and its lid); a drum's
   * floor tag (flat). Their projected hulls are what a connection label
   * plate must stay off at the default framing. */
  private nodeSolids(): { id: string; kind: 'card' | 'drum' | 'tag'; pts: { x: number; y: number; z: number }[] }[] {
    const out: { id: string; kind: 'card' | 'drum' | 'tag'; pts: { x: number; y: number; z: number }[] }[] = []
    const boxPts = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
      const pts: { x: number; y: number; z: number }[] = []
      for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) pts.push({ x, y, z })
      return pts
    }
    for (const o of this.data.objects) {
      const unit = this.nodeGroups.get(o.id)
      if (!unit) continue
      const baseY = (unit.userData.baseY as number | undefined) ?? 0
      const r = this.objectRect(o)
      if (o.type === 'store') {
        const cx = r.x + r.w / 2
        const cz = r.y + r.h / 2
        const lidY = baseY + DRUM_H + (this.selectedIds.has(o.id) ? SELECTED_LIFT * 0.5 : 0)
        const pts: { x: number; y: number; z: number }[] = []
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2
          const x = cx + Math.cos(a) * DRUM_R
          const z = cz + Math.sin(a) * DRUM_R
          pts.push({ x, y: baseY, z }, { x, y: lidY, z })
        }
        out.push({ id: o.id, kind: 'drum', pts })
        const tag = this.storeTag(o, r)
        if (tag) out.push({ id: o.id, kind: 'tag', pts: boxPts(tag.x, tag.x + tag.w, baseY + 0.5, baseY + 0.5, tag.y, tag.y + tag.h) })
      } else {
        const topY = (unit.userData.topY as number | undefined) ?? baseY + CAMERA_PRESETS[this.preset].depth
        out.push({
          id: o.id,
          kind: 'card',
          pts: [...boxPts(r.x, r.x + r.w, baseY, topY, r.y, r.y + r.h), ...boxPts(r.x - 7, r.x + r.w + 7, baseY, baseY + 2.6, r.y - 7, r.y + r.h + 7)],
        })
      }
    }
    return out
  }

  /** Enter choreography: the first frame is the flat 2D reading — top-down
   * camera at framing identity with the given 2D viewport, floor undressed —
   * then ONE design-curve tween carries camera pose + floor opacity to the
   * active preset. Without a 2D viewport (share viewer) the top-down start
   * frames the preset's own bounds. Jump-cuts under reduced motion. */
  enterMorph(
    view2d: { x: number; y: number; scale: number } | null,
    css?: { width: number; height: number },
  ): void {
    const target = this.enterTargetPose()
    const start =
      view2d && css
        ? poseFor2dViewport(view2d, css, target.fov)
        : { ...target, polar: 1, azimuth: 0, distance: target.distance * 1.06 }
    this.lastEnterStart = { ...start }
    this.rig.setPose(start)
    this.floorAlpha = 0
    this.applyFloorAlpha()
    // An undressed floor is a TRANSPARENT floor, which is another program
    // variant for every faded material — compile those too, and start the
    // tweens only once they are linked, so the morph plays from frame one
    // instead of from wherever the clock got to during a stall.
    const gen = ++this.enterGen
    this.enterPending = true
    this.scheduleCompile()
    void this.whenCompiled().then(() => {
      // an exit (or a newer enter) since then owns the camera
      if (this.disposed || gen !== this.enterGen) return
      this.enterPending = false
      this.rig.tweenTo(target)
      this.startFloorFade(1)
    })
  }

  /** Where the enter morph lands: the base preset pose (the design framing).
   * Quality loop 4 briefly landed it on the chrome-aware fit pose so the
   * cold shot showed the whole board; that halved every card face on screen
   * and the user rejected it (see below). The desk decor is still aimed at
   * the fit framing (showcaseView), which fit-to-screen shows. */
  private enterTargetPose(): CameraPose {
    const bounds = this.contentBounds()
    // USER FEEDBACK 2026-10-10 ("régressions sur la police et la taille de la
    // police"): landing on the fit pose put the camera ~2x farther than the
    // base preset pose, so every card face read at half its design size. The
    // enter morph lands on the base preset pose again; fit-to-screen (frame())
    // keeps the exact chrome-aware fit for whoever asks for the whole board.
    return this.rig.presetPoseFor(this.preset, bounds)
  }

  /** The host has committed to an enter morph that will start once the
   * programs link (Canvas3DView). Until the enter tween actually starts, the
   * readiness probe reports the camera as animating: "nodes present and not
   * animating" must never be true before the morph has even begun. */
  holdForEnter(): void {
    this.enterPending = true
  }

  /** Exit choreography: compute the 2D viewport the current camera hands
   * back (framing identity at the css centre), reverse-tween to its top-down
   * pose while the floor dressing fades out. Returns the handoff viewport so
   * the host can pre-set the flat canvas beneath the crossfade; `onDone` fires
   * when the camera lands (immediately under reduced motion; dropped if the
   * tween is interrupted — hosts keep a fallback timer). */
  exitMorph(css: { width: number; height: number }, onDone: () => void): { x: number; y: number; scale: number } {
    // a deferred enter still waiting on its compile must not start afterwards
    this.enterGen++
    this.enterPending = false
    const pose = this.rig.getPose()
    const view = viewportForPose(pose, css)
    this.rig.tweenTo(poseFor2dViewport(view, css, pose.fov), CAMERA_TWEEN_MS, onDone)
    this.startFloorFade(0)
    return view
  }

  resetCamera(): void {
    this.rig.goToPreset(this.preset, this.contentBounds(), false)
  }

  /** The camera pose (read-only copy) — hosts derive drill dive/retreat
   * distances from the live framing. */
  getCameraPose(): CameraPose {
    return this.rig.getPose()
  }

  /** Project a DOM pointer onto the diagram's y=0 floor. The returned x/y use
   * the same model coordinate system as the 2D canvas (Three's z maps to 2D y),
   * which keeps presence coherent when collaborators use different views. */
  presencePointAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    this.raycaster.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.rig.camera,
    )
    const point = this.raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      new THREE.Vector3(),
    )
    return point ? { x: point.x, y: point.z } : null
  }

  /** Convert diagram/model coordinates into CSS pixels in the WebGL host. */
  projectPresencePoint(x: number, y: number): { x: number; y: number; visible: boolean } {
    const rect = this.canvas.getBoundingClientRect()
    const point = new THREE.Vector3(x, 1, y).project(this.rig.camera)
    return {
      x: ((point.x + 1) / 2) * rect.width,
      y: ((1 - point.y) / 2) * rect.height,
      visible: point.z >= -1 && point.z <= 1
        && point.x >= -1.2 && point.x <= 1.2
        && point.y >= -1.2 && point.y <= 1.2,
    }
  }

  /** Model-viewer drill (first half): fly toward/away from a world point — the
   * 3D twin of the 2D zoom layer scaling into the opened tile. `onComplete` is
   * dropped if free navigation interrupts the tween — callers keep a fallback
   * timer (same contract as CameraRig.tweenTo). */
  flyTo(x: number, z: number, distance: number, durationMs?: number, onComplete?: () => void): void {
    const pose = this.rig.getPose()
    this.rig.tweenTo(
      { ...pose, targetX: x, targetZ: z, distance: Math.max(120, distance) },
      durationMs ?? CAMERA_TWEEN_MS,
      onComplete,
    )
  }

  /** Model-viewer drill (second half, post data-swap): land on the preset
   * framing of the NEW level starting from a pose scaled by `startFactor`
   * (>1 = arrive from afar, the level "blooms out" of the point dived into;
   * <1 = start zoomed-in and pull back out, the ascend reading). */
  arriveFrom(x: number, z: number, startFactor: number, durationMs?: number): void {
    const target = this.rig.presetPoseFor(this.preset, this.contentBounds())
    this.rig.setPose({
      ...target,
      targetX: x,
      targetZ: z,
      distance: Math.max(120, target.distance * startFactor),
    })
    this.rig.tweenTo(target, durationMs ?? CAMERA_TWEEN_MS)
  }

  /** Showcase mode (viewer/embeds): slow auto-orbit. No-ops under
   * reduced motion — the host also hides its toggle, this is the backstop. */
  setShowcase(on: boolean): void {
    const enable = on && !this.rig.prefersReducedMotion()
    if (enable === this.showcase) return
    this.showcase = enable
    this.showcaseLastNow = 0
    if (enable) {
      this.requestRender()
    } else if (this.showcaseResumeTimer !== null) {
      clearTimeout(this.showcaseResumeTimer)
      this.showcaseResumeTimer = null
    }
  }

  isShowcase(): boolean {
    return this.showcase
  }

  isCameraAnimating(): boolean {
    return this.rig.isAnimating()
  }

  isCameraDirty(): boolean {
    return this.rig.dirty
  }

  dispose(): void {
    this.disposed = true
    if (getActiveScene3D() === this) setActiveScene3D(null)
    if (this.raf) cancelAnimationFrame(this.raf)
    if (this.decorRebuildRaf !== null) cancelAnimationFrame(this.decorRebuildRaf)
    if (this.showcaseResumeTimer !== null) {
      clearTimeout(this.showcaseResumeTimer)
      this.showcaseResumeTimer = null
    }
    for (const fn of this.detachFns) fn()
    this.clearSmartGuides(true)
    this.smartGuideLayer.removeFromParent()
    this.clearRoot()
    this.flushRetiredMaterials() // no next frame: release them now
    this.cityJob = null // a slice still queued sees disposed and stops
    this.cancelLabelJob()
    this.labelChannel?.port1.close()
    this.labelChannel = null
    for (const m of this.connProgramKeepers.values()) m.dispose()
    this.connProgramKeepers.clear()
    if (this.cityGeom) disposeCityGeometry(this.cityGeom.geom)
    this.cityGeom = null
    for (const g of this.slabGeoCache.values()) g.dispose()
    this.slabGeoCache.clear()
    this.voxelTransient.clear()
    disposeIconTextures()
    disposeThemeAssets()
    this.floorMapClone?.clone.dispose()
    this.floorMapClone = null
    for (const [, tex] of sharedTextures) tex.dispose()
    sharedTextures.clear()
    disposeCuttingMatTextures()
    disposeWorkbenchTextures() // the desk tile + its vignette (lit/wood.ts)
    disposeCityFacadeTextures() // the city's facade atlas (decor/cityFacade.ts)
    this.cancelDecorRefreshIdle()
    if (this.decorRefreshTimer !== null) {
      clearTimeout(this.decorRefreshTimer)
      this.decorRefreshTimer = null
    }
    disposeDecorGeometries()
    releaseDecorAssetGpu()
    // Lit-profile resources live OUTSIDE root (clearRoot never sees them).
    this.disposePost()
    disposeLightRig(this.scene, this.litRig)
    this.litRig = null
    if (this.litEnvHeld) {
      releaseRoomEnvironment(this.renderer)
      this.litEnvHeld = false
      this.envSeq++
      this.scene.environment = null
    }
    disposeGradientBackdrop(this.backdrop)
    this.backdrop = null
    this.depthWarmer.dispose()
    this.depthWarmTarget?.dispose()
    this.depthWarmTarget = null
    // Dispose-residue accounting (§0 leak bar): after every disposal above,
    // what does the renderer still count as allocated? Deterministic — a
    // leaked geometry/texture shows up here as residue. Stashed on a global
    // that OUTLIVES the __scene3d handle so the e2e leak drill can read it
    // after the board unmounts (small legit residue: troika's shared SDF
    // atlas + font textures are module-global by design and reused).
    if (import.meta.env.DEV) {
      window.__scene3dDisposeResidue = {
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
      } satisfies Scene3dDisposeResidue
    }
    this.renderer.dispose()
    // hosts chained on whenCompiled() must not hang on a scene that is gone
    // (their continuations re-check `disposed` and do nothing)
    const waiters = this.compileWaiters
    this.compileWaiters = []
    for (const w of waiters) w()
    if (import.meta.env.DEV || import.meta.env.VITE_SCENE3D_PROBE === 'on') {
      if (window.__scene3d === this.devProbeIdentity) delete window.__scene3d
      this.devProbeIdentity = null
    }
  }

  // ── render loop (on demand) ────────────────────────────────────────────────

  requestRender(): void {
    if (this.disposed) return
    // Every generic request may have moved, added or hidden a shadow caster.
    this.shadowsDirty = true
    this.requestCameraRender()
  }

  /** A frame whose ONLY change is the camera (the rig's onChange: orbit, pan,
   * dolly, tweens). The lit sun's shadow camera is fitted to the board, not to
   * the view, so the shadow map from the last scene change is still exact —
   * re-rendering every caster into it on each orbit frame was pure cost. */
  private requestCameraRender(): void {
    if (this.disposed) return
    this.needsRender = true
    if (!this.raf && !this.compiling && !this.connCompiling) {
      this.rafRequestedAt = performance.now()
      this.raf = requestAnimationFrame(this.frameTick)
    }
  }

  /** Compile every program the scene now needs WITHOUT blocking the main
   * thread, and hold the render loop until they are linked.
   *
   * Measured (scripts/view3d-quality, RTX 4080 / ANGLE D3D11, 2026-10-08):
   * the first frame after entering 3D spent 2 009 ms in three's synchronous
   * `onFirstUse` and the first frame after picking the city background spent
   * 983 ms in `getProgramInfoLog` — 40-47 programs linked one after another on
   * the main thread, against ~70 ms for the whole geometry rebuild. Through
   * `compileAsync` the driver links them in parallel (KHR_parallel_shader_compile)
   * while the page stays responsive; the canvas simply keeps presenting its
   * previous frame until the new programs are ready.
   *
   * Superseded compiles are ignored by sequence number, so a burst of rebuilds
   * resolves once, on the LAST scene state. */
  private scheduleCompile(): void {
    if (this.disposed || this.contextLost) return
    const seq = ++this.compileSeq
    this.compiling = true
    const t0 = performance.now()
    if (this.compileGateSince === 0) this.compileGateSince = t0
    // the IBL is part of every lit program's key: compile against the scene
    // the frame will actually draw, never against a pre-environment one
    // …and the decor GLBs: their props are built only once they settle
    // …and the city ring when it is still being built in slices (mountCity)
    const pending = Promise.all([this.envPending, this.decorAssetsPending, this.cityPending]).then(() =>
      seq === this.compileSeq && !this.disposed ? this.compileSceneFor(this.post) : undefined,
    )
    // Ceiling: a program whose status is never reported ready (lost context
    // mid-compile, a driver that drops the parallel-compile query) must not
    // hold the board hostage — after this, render and let the first draw block.
    // Anchored at the moment the gate CLOSED, not at this call: superseding
    // rebuilds less than COMPILE_GATE_MAX_MS apart would otherwise restart it
    // forever and hold the loop indefinitely.
    const left = Math.max(0, COMPILE_GATE_MAX_MS - (t0 - this.compileGateSince))
    const ceiling = new Promise<void>((resolve) => setTimeout(resolve, left))
    let linked = false
    void Promise.race([pending.then(() => (linked = true)), ceiling])
      .catch(() => {
        /* a failed program still renders (and logs) on first use — never hold the loop */
      })
      .then(() => {
        if (this.disposed || seq !== this.compileSeq) return
        // every program is linked: draw everything once, off screen, and
        // hold until the GPU has executed it (warmDraw) — never after the
        // ceiling, when a draw would block on an unlinked program instead
        if (!linked) return
        this.settlePrograms()
        return this.warmDraw(Math.max(0, COMPILE_GATE_MAX_MS - (performance.now() - this.compileGateSince)))
      })
      .catch(() => {
        /* the warm draw is an optimisation — never hold the loop on it */
      })
      .then(() => {
        if (this.disposed || seq !== this.compileSeq) return
        this.compiling = false
        this.compileGateSince = 0
        this.buildTimings.compileMs = performance.now() - t0
        this.settlePrograms()
        const waiters = this.compileWaiters
        this.compileWaiters = []
        for (const w of waiters) w()
        this.requestRender()
      })
  }

  /** Draw the WHOLE scene once — frustum culling off — into the composer's
   * scene buffer, between frames, and resolve once the GPU has executed it
   * (a fence polled from timers: the main thread never waits on it).
   *
   * Measured (view3d quality loop 4, DPR 2, Chrome trace of the enter): the
   * 150-310 ms composed frames ~350 ms into the enter morph had no link, no
   * upload and no resize of their own (perfInfo().slowFrames), and the trace
   * put the whole frame in `CommandBufferHelper::WaitForAvailableEntries` on
   * the renderer while the GPU main thread spent 237 ms inside ONE WebGL
   * `CommandBuffer::Flush`. The morph starts from the 2D framing (tight, top
   * down) and pulls back: props, desk and background meet the frustum for
   * the first time mid-tween, and their first draw is where ANGLE builds the
   * D3D executables for that geometry's input layout — work three's
   * compileAsync cannot see (it links programs, it draws nothing). Drawn
   * here, that cost lands while the gate already holds the previous frame.
   * Composer-less boards are skipped: drawing into any target but the
   * canvas would key new program variants, and drawing into the canvas
   * outside a frame would present it. */
  private warmDraw(budgetMs: number): Promise<void> {
    const stack = this.post
    if (!stack || this.contextLost || budgetMs <= 0) return Promise.resolve()
    const renderer = this.renderer
    const gl = renderer.getContext()
    if (!(gl instanceof WebGL2RenderingContext)) return Promise.resolve()
    const culled: THREE.Object3D[] = []
    const hidden: THREE.Object3D[] = []
    const holdsLight = (o: THREE.Object3D): boolean => {
      let found = false
      o.traverse((c) => {
        if ((c as THREE.Light).isLight) found = true
      })
      return found
    }
    this.scene.traverse((o) => {
      if (o.frustumCulled) {
        culled.push(o)
        o.frustumCulled = false
      }
      // LOD-hidden decorations (far titles, decor tiers) show up at the END
      // of the morph, when the camera settles (updateNodeLod) — warm them
      // too (their programs are linked: three's compile walks invisible
      // objects). Never a light: the light set is part of every program key.
      if (!o.visible && o !== this.scene && !holdsLight(o)) {
        hidden.push(o)
        o.visible = true
      }
    })
    const prev = renderer.getRenderTarget()
    // the shadow map is the frame's business (shadowsDirty / primeShadowPass)
    const shadowNeeds = renderer.shadowMap.needsUpdate
    renderer.shadowMap.needsUpdate = false
    try {
      for (const b of this.billboards) b.quaternion.copy(this.rig.camera.quaternion)
      renderer.setRenderTarget(stack.sceneTarget)
      renderer.render(this.scene, this.rig.camera)
    } catch {
      /* lost context mid-draw: the restore path rebuilds */
    } finally {
      renderer.setRenderTarget(prev)
      renderer.shadowMap.needsUpdate = shadowNeeds
      for (const o of culled) o.frustumCulled = true
      for (const o of hidden) o.visible = false
    }
    this.warmDraws++
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    if (!sync) return Promise.resolve()
    gl.flush()
    const t0 = performance.now()
    return new Promise<void>((resolve) => {
      const poll = () => {
        if (this.disposed || this.contextLost || performance.now() - t0 > budgetMs) {
          if (!this.contextLost) gl.deleteSync(sync)
          resolve()
          return
        }
        if (gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED) {
          gl.deleteSync(sync)
          this.warmDrawMs = performance.now() - t0
          resolve()
          return
        }
        setTimeout(poll, 4)
      }
      poll()
    })
  }

  /** Off-screen whole-scene draws run by the compile gate (warmDraw), and
   * how long the GPU took to execute the last one (perfInfo probe). */
  private warmDraws = 0
  private warmDrawMs = 0

  /** Start (non-blocking) compiles of every program the NEXT frame will use
   * and resolve when the driver reports them linked.
   *
   * With a post stack the scene is drawn into the composer's linear buffer,
   * not the canvas, and three keys programs on the bound target — so the
   * compile runs with that target bound. Getting this wrong is invisible in
   * the code and very visible in the profile: the canvas variants compiled
   * here, then the first composed frame linked every real variant
   * synchronously (1 067 ms under `post.render`, enter-3D profile 2026-10-08).
   * `stack.passMaterials()` adds the passes' own quads, which live in no scene
   * and are compiled for both a buffer and the canvas (the last pass). */
  private compileSceneFor(stack: PostStack | null, withPasses = false): Promise<unknown> {
    const jobs: Promise<unknown>[] = []
    const prev = this.renderer.getRenderTarget()
    try {
      if (stack) this.renderer.setRenderTarget(stack.sceneTarget)
      jobs.push(compileAndWait(this.renderer, this.scene, this.rig.camera))
      // The shadow pass's depth programs: invisible to the compile above
      // (three's depth material is in no scene — lit/shadowWarm.ts). Keyed
      // like the shadow pass draws them: a target bound (linear, untoned),
      // the scene's lights and shadows, and NO fog (the pass draws with an
      // empty scene). The fog is lifted only for this synchronous call.
      if (this.renderer.shadowMap.enabled) {
        const depthWarm = this.depthWarmer.buildWarmScene(this.scene)
        if (depthWarm) {
          this.depthWarmTarget ??= new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false })
          this.renderer.setRenderTarget(this.depthWarmTarget)
          const fog = this.scene.fog
          this.scene.fog = null
          try {
            jobs.push(compileAndWait(this.renderer, depthWarm, this.rig.camera, this.scene))
          } finally {
            this.scene.fog = fog
            this.depthWarmer.releaseReferences()
          }
          this.renderer.setRenderTarget(stack ? stack.sceneTarget : null)
        }
      }
      if (stack && withPasses) {
        const warm = new THREE.Scene()
        // position + uv ONLY, like the passes' own fullscreen triangle: a
        // normal attribute flips three's `vertexNormals` key bit and the warm
        // program would be a sibling nobody uses
        const quad = new THREE.BufferGeometry()
        quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
        quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2))
        for (const m of stack.passMaterials()) warm.add(new THREE.Mesh(quad, m))
        jobs.push(compileAndWait(this.renderer, warm, this.rig.camera))
        this.renderer.setRenderTarget(null)
        jobs.push(compileAndWait(this.renderer, warm, this.rig.camera).finally(() => quad.dispose()))
      }
    } catch {
      /* compile() threw (lost context): first use will report it */
    } finally {
      this.renderer.setRenderTarget(prev)
    }
    return Promise.all(jobs)
  }

  /** Debug/perf: the last loop frames that took ≥ 40 ms (perfInfo probe) —
   * attributes a long task to a frame, its build and its kind, and tells a
   * program LINK (programs delta), an UPLOAD (textures/geometries delta) and
   * a target REALLOCATION (resized since the previous frame) apart — the
   * loop4-r1-dpr2 277 ms composed frame carried none of that and could not
   * be attributed (report.json profile: null). */
  private slowFrameLog: Scene3dSlowFrame[] = []
  /** Threshold of slowFrameLog (ms). The probe lowers it for a measured
   * window: the loop4-r3-dpr2 first-orbit hitch was 35.6 ms, under both the
   * 40 ms default and the 50 ms floor of long tasks / LoAF entries, so
   * nothing in the report could say what it was. */
  private slowFrameMs = 40
  /** setSize/pixel-ratio change since the last rendered frame (slowFrameLog). */
  private resizedSinceFrame = false
  /** Loop frames rendered since the post stack went live (slowFrameLog). */
  private framesSincePost = 0

  /** Programs alive when the current frame started (slowFrameLog). */
  private programsBefore = new Set<object>()

  /** Snapshot taken at a frame's start (noteSlowFrame compares against it). */
  private frameCounters(): { textures: number; geometries: number; shadow: boolean } {
    const info = this.renderer.info
    this.programsBefore.clear()
    for (const p of info.programs ?? []) this.programsBefore.add(p)
    return {
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      // the frame will re-render the cached shadow map (renderFrameInner)
      shadow: this.shadowsDirty || this.renderer.shadowMap.needsUpdate,
    }
  }

  /** Main-thread work the scene runs OUTSIDE its render loop (decor refresh,
   * the settle-edge LOD/label pass), timed into slowFrameLog under `kind` so
   * a hitch between frames is attributed like a slow frame. */
  private timedTask<T>(kind: string, fn: () => T): T {
    const t0 = performance.now()
    const before = this.frameCounters()
    const resized = this.resizedSinceFrame
    try {
      return fn()
    } finally {
      this.noteSlowFrame(kind, t0, before)
      // a task is not the frame that pays a pending resize
      this.resizedSinceFrame = resized
    }
  }

  private noteSlowFrame(kind: string, t0: number, before: { textures: number; geometries: number; shadow: boolean }): void {
    const resized = this.resizedSinceFrame
    this.resizedSinceFrame = false
    const ms = performance.now() - t0
    if (ms < this.slowFrameMs) return
    const after = this.renderer.info.memory
    // by identity, not by count: a variant switch that links one program and
    // releases another nets to zero
    let linked = 0
    for (const p of this.renderer.info.programs ?? []) if (!this.programsBefore.has(p)) linked++
    this.slowFrameLog.push({
      atMs: Math.round(t0),
      ms: Math.round(ms),
      build: this.buildTimings.builds,
      kind,
      newPrograms: linked,
      newTextures: after.textures - before.textures,
      newGeometries: after.geometries - before.geometries,
      resized,
      shadow: before.shadow,
      frame: this.framesSincePost,
      floorAlpha: Math.round(this.floorAlpha * 100) / 100,
      fadeMs: this.floorTween ? Math.round(t0 - this.floorTween.start) : -1,
    })
    if (this.slowFrameLog.length > 32) this.slowFrameLog.shift()
  }

  /** Programs whose first-use introspection already ran (settlePrograms). */
  private settledPrograms = new WeakSet<object>()

  /** Run three's first-use introspection of every LINKED program now, while
   * the GPU queue is empty, instead of inside the next frame.
   *
   * A program's first draw calls `getUniforms()` → `onFirstUse`: the uniform
   * and attribute tables (plus link status and info logs while
   * `checkShaderErrors` is on) — synchronous GL queries, each of which waits
   * for the GPU process to drain every command queued before it. Mid-frame,
   * that is the shadow pass and the draws issued so far, once per program
   * drawn for the first time. Measured (view3d-quality loop1-r3 enter-3D
   * profile, 2026-10-08): 158 ms of `onFirstUse` self time inside one
   * `post.render()`, with `postFirstNewPrograms` already empty — linked, but
   * never asked. Asked here, between frames, each query returns at once.
   * Unready programs are skipped (asking would block on their link). */
  private settlePrograms(): void {
    for (const p of this.renderer.info.programs ?? []) {
      if (this.settledPrograms.has(p)) continue
      const ready = (p as THREE.WebGLProgram & { isReady?: () => boolean }).isReady?.() ?? true
      if (!ready) continue
      p.getUniforms()
      this.settledPrograms.add(p)
    }
  }

  /**
   * The compile gate of a connection build that comes WITHOUT a full
   * rebuild's (a selection, a drag frame, a reconnect): the layer may hold a
   * program the scene never linked — on the test board a cable click added
   * three (the focus-dimmed cables' transparent variant and two basic ones)
   * — and the first frame then linked them synchronously (getProgramInfoLog
   * 72 ms self in the 120-ms task of the click, reconnect-select profile,
   * tp5-connect3d, once setSelection stopped rebuilding the whole scene).
   * buildConnProgramWarmers now links those in the full rebuild's gate;
   * this gate catches the rest (a highlight style switched later, …).
   * Compiled like compileSceneFor compiles the scene — against the target
   * the frame draws into — and the frame held until the driver reports the
   * layer's programs linked; programs already linked resolve at once.
   */
  private scheduleConnCompile(): void {
    if (this.disposed || this.contextLost) return
    const seq = ++this.connCompileSeq
    const prev = this.renderer.getRenderTarget()
    let job: Promise<unknown>
    try {
      if (this.post) this.renderer.setRenderTarget(this.post.sceneTarget)
      job = compileAndWait(this.renderer, this.connLayer, this.rig.camera, this.scene)
    } catch {
      return // lost context: first use reports it
    } finally {
      this.renderer.setRenderTarget(prev)
    }
    this.connCompiling = true
    const ceiling = new Promise<void>((resolve) => setTimeout(resolve, COMPILE_GATE_MAX_MS))
    void Promise.race([job, ceiling])
      .catch(() => {
        /* a failed program still renders (and logs) on first use */
      })
      // …and their first-use introspection, between frames (settlePrograms:
      // linked is not enough — with the compile above resolved, the next
      // frame still spent 105 ms in getProgramInfoLog), one program per task.
      // (Measured: the three of a cable click took 65-124 ms as one settle
      // task, DEV shader checks. NOT measured: that slicing shortens it —
      // the first query may wait for every link queued before it.)
      .then(() => (seq === this.connCompileSeq && !this.disposed ? this.settleProgramsSliced() : undefined))
      .then(() => {
        if (seq !== this.connCompileSeq || this.disposed) return
        this.connCompiling = false
        this.requestRender()
      })
  }
  private connCompiling = false
  private connCompileSeq = 0

  /** settlePrograms, one program per task (scheduleConnCompile). */
  private settleProgramsSliced(): Promise<void> {
    return new Promise((resolve) => {
      const step = () => {
        if (this.disposed || this.contextLost) return resolve()
        for (const p of this.renderer.info.programs ?? []) {
          if (this.settledPrograms.has(p)) continue
          if (!((p as THREE.WebGLProgram & { isReady?: () => boolean }).isReady?.() ?? true)) continue
          p.getUniforms()
          this.settledPrograms.add(p)
          setTimeout(step, 0)
          return
        }
        resolve()
      }
      step()
    })
  }

  /** Resolves once no shader compile is pending — hosts delay the enter morph
   * on it, so the 2D board stays on screen instead of a frozen page. */
  whenCompiled(): Promise<void> {
    if (!this.compiling || this.disposed) return Promise.resolve()
    return new Promise((resolve) => this.compileWaiters.push(resolve))
  }

  private frameTick = (now: number) => {
    this.raf = 0
    if (this.disposed) return
    // Context lost: skip the frame entirely. `needsRender` stays latched; the
    // restore handler's rebuild() re-kicks the loop once the context is back.
    if (this.contextLost) return
    // Programs still linking: keep the latch, the compile's resolution re-kicks.
    if (this.compiling || this.connCompiling) {
      this.lastRenderAt = 0 // a hold is not a frame time (governor)
      return
    }
    const animating = this.rig.step(now)
    // Camera just settled → the projected sizes are final; re-evaluate LOD once.
    if (this.wasAnimating && !animating) this.timedTask('settle-lod', () => this.updateNodeLod())
    this.wasAnimating = animating
    const fading = this.stepFloorFade(now)
    const moving = this.stepMotion(now)
    const voxeling = this.stepVoxelFragments(now)
    const flowing = this.stepFlow(now)
    const hovering = this.stepHandleHover(now)
    const spinning = this.stepShowcase(now, animating)
    // theme bob/spin and breakaway fragments move casters every frame; camera
    // tweens, flow dots and the showcase drift do not
    if (moving || voxeling) this.shadowsDirty = true
    if (this.needsRender || animating || fading || moving || voxeling || flowing || hovering || spinning) {
      this.needsRender = false
      // billboard theme assets stay camera-facing through every orbit
      for (const b of this.billboards) b.quaternion.copy(this.rig.camera.quaternion)
      const tFrame = performance.now()
      const before = this.frameCounters()
      if (this.postFirstRenderPending && this.primeShadowPass()) {
        // the shadow map was this task's work; the composed frame is the
        // next one (primeShadowPass). Not a frame time for the governor.
        this.noteSlowFrame('shadow-prime', tFrame, before)
        this.lastRenderAt = 0
        this.requestCameraRender()
        return
      }
      this.renderFrame()
      if (this.post) this.framesSincePost++
      this.noteSlowFrame(this.post ? 'composed' : 'plain', tFrame, before)
      this.governFramePacing(now)
      // stamped BEFORE the continuation below requests the next rAF, so a
      // self-sustaining loop reads zero input wait (see governFramePacing)
      this.lastTickEnd = performance.now()
    } else {
      this.lastRenderAt = 0
    }
    // keep the loop alive; casters that moved already marked the shadows dirty
    // above, so a plain camera/flow frame must not (requestRender would)
    const continuing = animating || fading || moving || voxeling || flowing || spinning
    if (continuing) this.requestCameraRender()
    // a drag renders on pointer moves, not on a self-sustaining loop — its
    // frames are still consecutive; anything else idles and breaks the chain
    else if (this.pointer.mode === 'idle') this.lastRenderAt = 0
  }

  /** Advance the showcase auto-orbit. Returns true while drifting (keeps the
   * rAF alive). Any gesture or camera tween HOLDS it: the hold window is
   * pushed forward on every held frame, and a one-shot timer re-kicks the
   * loop after it expires — a held/paused showcase costs zero rAF. */
  private stepShowcase(now: number, cameraAnimating: boolean): boolean {
    if (!this.showcase) return false
    const held = this.pointer.mode !== 'idle' || cameraAnimating
    if (held) this.showcaseHoldUntil = Math.max(this.showcaseHoldUntil, now + SHOWCASE_RESUME_MS)
    if (held || now < this.showcaseHoldUntil) {
      this.showcaseLastNow = 0
      if (this.showcaseResumeTimer === null) {
        const delay = Math.max(50, this.showcaseHoldUntil - now + 50)
        this.showcaseResumeTimer = window.setTimeout(() => {
          this.showcaseResumeTimer = null
          this.requestRender()
        }, delay)
      }
      return false
    }
    const dt = this.showcaseLastNow ? Math.min(now - this.showcaseLastNow, 100) : 16
    this.showcaseLastNow = now
    const pose = this.rig.getPose()
    this.rig.setPose({ ...pose, azimuth: (pose.azimuth + (SHOWCASE_DEG_PER_S * dt) / 1000) % 360 })
    return true
  }

  /** Advance the focus flow animations — each unit's tick carries its own 2D
   * timing (dot 1500ms, sparkle 1800ms, gradient band 2000ms, pulse 1400ms,
   * lightning 1600ms, neon-dash 0.06px/ms, strands 0.002rad/ms, electric
   * summed-sine octaves + flicker, beam packet 1200ms + 0.004rad/ms wave). */
  private stepFlow(now: number): boolean {
    if (this.flowUnits.length === 0) return false
    for (const u of this.flowUnits) u.tick(now)
    return true
  }

  /** Advance a hovered edit handle's growth + glow (HANDLE_HOVER_MS,
   * --ease-out; instant under prefers-reduced-motion). True while it runs. */
  private stepHandleHover(now: number): boolean {
    const h = this.handleHover
    if (!h) return false
    const running = this.handleUniforms.uHoverT.value < 1
    this.handleUniforms.uHoverT.value = this.rig.prefersReducedMotion() ? 1 : easeOut((now - h.start) / HANDLE_HOVER_MS)
    // (one more frame once it lands, so 1 is drawn)
    return running
  }

  /** Hover edit handle `id` (null: none) — the glow and the 10 → 12 growth. */
  private setHandleHover(id: number | null): void {
    if ((this.handleHover?.id ?? null) === id) return
    this.handleHover = id === null ? null : { id, start: performance.now() }
    this.handleUniforms.uHoverId.value = id ?? -1
    this.handleUniforms.uHoverT.value = 0
    // the head and the knob are one target grip: hovering either lights the
    // knob (id 1) and brightens the line's halo by 20 %
    if (this.selectHalo) this.selectHalo.mat.opacity = this.selectHalo.base * (id === 1 ? 1.2 : 1)
    this.requestRender()
  }

  /** Advance theme micro-animations (spec spin/bob) — transforms only, no
   * rebuilds. Returns true while any unit is animating (keeps the rAF alive;
   * the default theme registers none, so idle rAF stays 0). */
  private stepMotion(now: number): boolean {
    if (this.motionUnits.length === 0) return false
    const t = now / 1000
    for (const m of this.motionUnits) {
      if (m.bob) m.obj.position.y = Math.sin((t * m.bob.speed * 2 + m.bob.phase) * Math.PI) * m.bob.amp
      if (m.spinObj && m.spinSpeed) m.spinObj.rotation.y = ((t * m.spinSpeed) % 360) * (Math.PI / 180)
    }
    return true
  }

  // ── morph floor fade ───────────────────────────────────────────────────────

  private startFloorFade(to: number, duration = CAMERA_TWEEN_MS): void {
    this.floorTween = null
    if (this.rig.prefersReducedMotion() || duration <= 0) {
      this.floorAlpha = to
      this.applyFloorAlpha()
      this.requestRender()
      return
    }
    this.floorTween = { from: this.floorAlpha, to, start: performance.now(), duration }
    this.requestRender()
  }

  private stepFloorFade(now: number): boolean {
    if (!this.floorTween) return false
    const { from, to, start, duration } = this.floorTween
    const t = Math.min(1, (now - start) / duration)
    this.floorAlpha = from + (to - from) * designEase(t)
    this.applyFloorAlpha()
    if (t >= 1) this.floorTween = null
    return this.floorTween !== null
  }

  /** Register a floor-dressing material for the morph fade. `base` is its
   * dressed opacity; shader materials fade through a uOpacity uniform.
   *
   * LAYERING INVARIANT: the floor may only be transparent WHILE the fade runs. A permanently
   * transparent slab renders in the transparent pass — i.e. after the opaque
   * ribbons/arrowheads (which don't write depth) and before/after its own
   * ground blob purely by sort luck — so it paints over the connection lines
   * and lets the radial ground shadow splash a huge circle across the board.
   * At rest the slab is opaque and depth-writing again, and every floor mesh
   * carries renderOrder −10 so the board always draws first in its pass. */
  private regFloorFade(mat: THREE.Material, base = 1, uniform?: THREE.IUniform<number>): void {
    this.floorFade.push({ mat, base, uniform, baseTransparent: mat.transparent, baseDepthWrite: mat.depthWrite })
  }

  private applyFloorAlpha(): void {
    const fading = this.floorAlpha < 1
    for (const f of this.floorFade) {
      if (f.uniform) f.uniform.value = f.base * this.floorAlpha
      else (f.mat as THREE.MeshBasicMaterial).opacity = f.base * this.floorAlpha
      f.mat.transparent = f.baseTransparent || fading
      f.mat.depthWrite = f.baseDepthWrite && !fading
    }
  }

  // ── scene building ─────────────────────────────────────────────────────────

  private contentBounds(): { cx: number; cz: number; width: number; height: number } {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const eat = (r: Rect) => {
      minX = Math.min(minX, r.x)
      minY = Math.min(minY, r.y)
      maxX = Math.max(maxX, r.x + r.w)
      maxY = Math.max(maxY, r.y + r.h)
    }
    for (const o of this.data.objects) eat({ x: o.position.x, y: o.position.y, w: o.size.width, h: o.size.height })
    for (const g of this.data.groups) eat(this.groupRect(g))
    if (!isFinite(minX)) {
      minX = 0
      minY = 0
      maxX = 800
      maxY = 500
    }
    return { cx: (minX + maxX) / 2, cz: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY }
  }

  /** The object ids of `data.objects`, cached per array. */
  private objectIdsOnScene(): Set<string> {
    if (this.objectIdsOf?.objects !== this.data.objects) {
      this.objectIdsOf = { objects: this.data.objects, ids: new Set(this.data.objects.map((o) => o.id)) }
    }
    return this.objectIdsOf.ids
  }

  /** The group's platform: groupPlatform.ts, the 2D computeGroupBounds contract. */
  private groupRect(g: Group): Rect {
    return groupPlatformRect(g, this.data.groups, this.data.objects, this.objectIdsOnScene())
  }

  private objectRect(o: C4Object): Rect {
    return { x: o.position.x, y: o.position.y, w: o.size.width, h: o.size.height }
  }

  private captureSmartGuideCandidates(
    excludedObjectIds: Set<string>,
    excludedGroupIds = new Set<string>(),
  ): void {
    const candidates: GuideRect[] = []
    for (const object of this.data.objects) {
      if (excludedObjectIds.has(object.id) || this.objectTagPerspective(object).hidden) continue
      const rect = this.objectRect(object)
      candidates.push({ id: object.id, x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    }
    for (const group of this.data.groups) {
      if (
        excludedGroupIds.has(group.id) ||
        group.objectIds.some((id) => excludedObjectIds.has(id))
      ) continue
      const rect = this.groupRect(group)
      candidates.push({ id: group.id, x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    }
    this.smartGuideCandidates = candidates
    this.smartGuides = []
    this.smartGuideSnap = { x: false, y: false }
    this.clearSmartGuideVisuals()
    if (import.meta.env.DEV) {
      delete this.canvas.dataset.smartGuidesCurrent
      delete this.canvas.dataset.smartGuidesLast
    }
  }

  private smartGuideToleranceWorld(): number {
    const size = this.renderer.getSize(this._lodSize)
    const viewport = viewportForPose(
      this.rig.getPose(),
      { width: Math.max(1, size.x), height: Math.max(1, size.y) },
    )
    return 6 / Math.max(viewport.scale, 0.01)
  }

  private updateSmartGuides(moving: GuideRect): { dx: number; dy: number } {
    const result = calculateSmartGuides(moving, this.smartGuideCandidates, this.smartGuideToleranceWorld())
    this.smartGuides = result.guides
    this.smartGuideSnap = { x: result.snappedX, y: result.snappedY }
    if (import.meta.env.DEV) {
      const probe = JSON.stringify({ guides: result.guides, snapped: this.smartGuideSnap })
      this.canvas.dataset.smartGuidesCurrent = probe
      if (result.guides.length > 0) this.canvas.dataset.smartGuidesLast = probe
    }
    this.renderSmartGuideVisuals()
    return { dx: result.dx, dy: result.dy }
  }

  private clearSmartGuideVisuals(): void {
    for (const text of this.smartGuideTexts) {
      text.removeFromParent()
      text.dispose()
    }
    this.smartGuideTexts = []
    for (const child of [...this.smartGuideLayer.children]) {
      child.traverse((object) => {
        const renderable = object as THREE.Mesh | THREE.Line
        renderable.geometry?.dispose()
        const material = renderable.material
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
        else material?.dispose()
      })
      child.removeFromParent()
    }
  }

  private clearSmartGuides(resetCandidates = false): void {
    this.clearSmartGuideVisuals()
    this.smartGuides = []
    this.smartGuideSnap = { x: false, y: false }
    if (import.meta.env.DEV) delete this.canvas.dataset.smartGuidesCurrent
    if (resetCandidates) this.smartGuideCandidates = []
  }

  private renderSmartGuideVisuals(): void {
    this.clearSmartGuideVisuals()
    if (!this.skin || this.smartGuides.length === 0) {
      this.requestRender()
      return
    }
    const scale = Math.max(0.01, 6 / this.smartGuideToleranceWorld())
    const extension = 8 / scale
    const cap = 5 / scale
    const lift = CAMERA_PRESETS[this.preset].plat + CAMERA_PRESETS[this.preset].depth + SELECTED_LIFT + 2
    const color = this.skin.selection.stroke
    const addLine = (points: Array<[number, number]>) => {
      const geometry = new THREE.BufferGeometry().setFromPoints(
        points.map(([x, z]) => new THREE.Vector3(x, lift, z)),
      )
      const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
      })
      const line = new THREE.Line(geometry, material)
      line.renderOrder = 2000
      this.smartGuideLayer.add(line)
    }

    for (const guide of this.smartGuides) {
      if (guide.kind === 'alignment') {
        addLine(guide.axis === 'x'
          ? [[guide.value, guide.from - extension], [guide.value, guide.to + extension]]
          : [[guide.from - extension, guide.value], [guide.to + extension, guide.value]])
        continue
      }

      if (guide.axis === 'x') {
        addLine([[guide.start, guide.cross], [guide.end, guide.cross]])
        addLine([[guide.start, guide.cross - cap], [guide.start, guide.cross + cap]])
        addLine([[guide.end, guide.cross - cap], [guide.end, guide.cross + cap]])
      } else {
        addLine([[guide.cross, guide.start], [guide.cross, guide.end]])
        addLine([[guide.cross - cap, guide.start], [guide.cross + cap, guide.start]])
        addLine([[guide.cross - cap, guide.end], [guide.cross + cap, guide.end]])
      }

      const label = String(Math.round(guide.distance))
      const x = guide.axis === 'x' ? (guide.start + guide.end) / 2 : guide.cross + 10 / scale
      const z = guide.axis === 'x' ? guide.cross - 9 / scale : (guide.start + guide.end) / 2
      const labelWidth = (label.length * 6 + 8) / scale
      const labelHeight = 14 / scale
      const bgColor = colorAlpha(this.skin.connections.labelBg)
      const bg = new THREE.Mesh(
        new THREE.PlaneGeometry(labelWidth, labelHeight),
        new THREE.MeshBasicMaterial({
          color: bgColor.color,
          transparent: bgColor.alpha < 1,
          opacity: bgColor.alpha,
          depthTest: false,
          depthWrite: false,
        }),
      )
      bg.rotation.x = -Math.PI / 2
      bg.position.set(x, lift + 0.1, z)
      bg.renderOrder = 2001
      this.smartGuideLayer.add(bg)

      const text = this.addText({
        text: label,
        font: 'inter600',
        size: 10 / scale,
        color,
        anchorX: 'center',
        anchorY: 'middle',
      }, this.smartGuideTexts)
      text.position.set(x, lift + 0.2, z)
      text.renderOrder = 2002
      const textMaterial = text.material as THREE.Material
      textMaterial.depthTest = false
      textMaterial.depthWrite = false
      this.smartGuideLayer.add(text)
    }
    this.requestRender()
  }

  private dataSignature(): string {
    const parts: string[] = [
      this.preset,
      String(this.data.groups.length),
      // accent-bar inputs: active tab + sanitized Tag snapshot values/colors
      `bar:${this.bottomTab ?? ''}:${this.activeTagGroupId ?? ''}|${this.data.tags.map((t) => `${t.tagId}:${t.value}=${t.color}`).join(',')}`,
      `tagfx:${this.hoveredTagId ?? ''}:${this.focusedTagId ?? ''}:${this.pinnedTagIds.join(',')}:${[...this.hiddenTagIds].sort().join(',')}`,
      ...(['technology', 'status', 'teams'] as const).map((kind) => {
        const interaction = this.managedPerspectiveInteractions[kind]
        return `${kind}fx:${interaction.hoveredId ?? ''}:${interaction.focusedId ?? ''}:${interaction.pinnedIds.join(',')}:${[...interaction.hiddenIds].sort().join(',')}`
      }),
    ]
    for (const o of this.data.objects) {
      parts.push(
        `${o.id}|${o.size.width}x${o.size.height}|${o.name}|${objectShortDescription(o) ?? ''}|${o.type}|${o.scope}|${orderedTechnologyUsages(o.technologyUsages, o.technologyUsageOrder)
          .map((usage) => usage.snapshot.name)
          .join(',')}|${o.tagOrder.join(',')}|${o.status ?? ''}|${o.icon ?? ''}|${o.iconAssignment?.iconLightPath ?? ''}|${o.iconAssignment?.iconDarkPath ?? ''}|${this.selectedIds.has(o.id) ? 1 : 0}|${
          this.expandableIds.has(o.id) ? 1 : 0
        }`,
      )
    }
    for (const g of this.data.groups)
      parts.push(
        `${g.id}|${g.name}|${g.icon ?? ''}|${g.iconAssignment?.iconLightPath ?? ''}|${g.iconAssignment?.iconDarkPath ?? ''}|${g.borderColor ?? ''}|${g.fillTransparent ? 1 : 0}|${this.selectedIds.has(g.id) ? 1 : 0}`,
      )
    return parts.join('\n')
  }

  private refreshTagFocusMembership(): void {
    const managed = this.activeManagedPerspective()
    const membership = managed
      ? resolveFacetFocusMembership(
        this.data.objects,
        this.data.connections,
        managed,
        this.managedPerspectiveInteractions[managed].focusedId,
      )
      : resolveTagFocusMembership(
        this.data.objects,
        this.data.connections,
        this.data.tags,
        this.bottomTab === 'tags' ? this.focusedTagId : null,
      )
    this.tagFocusResolved = membership.resolved
    this.tagFocusObjectIds = new Set(membership.matchingObjectIds)
    this.tagConnectedObjectIds = new Set(membership.connectedObjectIds)
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

  private objectTagPerspective(o: C4Object): { hidden: boolean; alpha: number } {
    const managed = this.activeManagedPerspective()
    const interaction = managed ? this.managedPerspectiveInteractions[managed] : null
    const hidden = managed && interaction
      ? resolveHiddenFacetState(o, managed, interaction.hiddenIds, interaction.hoveredId)
      : this.bottomTab === 'tags'
        ? resolveHiddenTagState(o, this.hiddenTagIds, this.hoveredTagId)
        : { hidden: false, temporarilyRevealed: false }
    if (hidden.hidden) return { hidden: true, alpha: 0 }
    let alpha = hidden.temporarilyRevealed ? 0.4 : 1
    if (this.activeFocusedPerspectiveId() && this.tagFocusResolved) {
      if (this.tagFocusObjectIds.has(o.id)) alpha *= 1
      else if (this.tagConnectedObjectIds.has(o.id)) alpha *= 0.4
      else alpha *= 0.15
    }
    return { hidden: false, alpha }
  }

  /** Dim one freshly-built object without mutating cache-owned theme assets. */
  private applyUnitOpacity(unit: THREE.Group, alpha: number): void {
    if (alpha >= 0.999) return
    unit.traverse((object) => {
      if ('fillOpacity' in object) {
        const text = object as THREE.Object3D & { fillOpacity: number }
        text.fillOpacity = (text.fillOpacity ?? 1) * alpha
        return
      }
      const mesh = object as THREE.Mesh
      if (object.userData.sharedAsset && mesh.material) {
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((material) => material.clone())
          : mesh.material.clone()
        object.userData.tagPerspectiveMaterialClone = true
      }
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
      for (const material of materials) {
        if (material instanceof THREE.ShaderMaterial && material.uniforms.uOpacity) {
          const uniform = material.uniforms.uOpacity as THREE.IUniform<number>
          uniform.value *= alpha
          material.transparent = true
          material.depthWrite = false
        } else if ('opacity' in material) {
          material.transparent = true
          material.opacity *= alpha
          material.depthWrite = false
        }
      }
    })
  }

  /** Hover glow, latest-pin outline and ordered pin labels for the 3D board. */
  private addTagPerspectiveDecorations(unit: THREE.Group, o: C4Object): void {
    const managed = this.activeManagedPerspective()
    if (this.bottomTab !== 'tags' && !managed) return
    const skin = this.skin!
    const facetColor = (value: { id: string; label: string }) => managed === 'technology'
      ? resolveTechnologyColor(value.label, skin)
      : managed === 'status'
        ? resolveStatusColor(value.id as C4Object['status'], skin)
        : resolveTeamColor(value.id)
    const managedInteraction = managed ? this.managedPerspectiveInteractions[managed] : null
    const hoveredTag = this.bottomTab === 'tags' && this.hoveredTagId && o.tagAssignments?.[this.hoveredTagId]
      ? this.data.tags.find((tag) => tag.tagId === this.hoveredTagId) ?? null
      : null
    const hoveredFacet = managed && managedInteraction?.hoveredId
      ? objectFacetValues(o, managed).find((value) => value.id === managedInteraction.hoveredId) ?? null
      : null
    const pinnedTag = resolvePinnedTagPresentation(o, this.data.tags, this.pinnedTagIds)
    const pinnedFacet = managed && managedInteraction
      ? resolvePinnedFacetPresentation(o, managed, managedInteraction.pinnedIds)
      : null
    const outlineId = hoveredTag?.tagId ?? hoveredFacet?.id ?? pinnedFacet?.outline?.id ?? pinnedTag.outline?.tagId ?? null
    const outlineLabel = hoveredTag?.value ?? hoveredFacet?.label ?? pinnedFacet?.outline?.label ?? pinnedTag.outline?.value ?? ''
    const outlineColor = hoveredTag
      ? resolveTagColor(hoveredTag.tagId, this.data.tags, skin) ?? hoveredTag.color
      : managed ? facetColor({ id: outlineId ?? outlineLabel, label: outlineLabel }) : pinnedTag.outline
        ? resolveTagColor(pinnedTag.outline.tagId, this.data.tags, skin) ?? pinnedTag.outline.color
        : null
    if (outlineId && outlineColor) {
      const ca = colorAlpha(outlineColor)
      const y = (unit.userData.topY as number | undefined ?? 0) + 0.75
      const points: THREE.Vector3[] = []
      if (o.type === 'store') {
        const cx = o.size.width / 2
        const cz = o.size.height / 2
        const segments = 48
        for (let index = 0; index < segments; index += 1) {
          const angle = (index / segments) * Math.PI * 2
          points.push(new THREE.Vector3(cx + Math.cos(angle) * (PAD_R + 4), y, cz + Math.sin(angle) * (PAD_R + 4)))
        }
      } else {
        points.push(
          new THREE.Vector3(-3, y, -3),
          new THREE.Vector3(o.size.width + 3, y, -3),
          new THREE.Vector3(o.size.width + 3, y, o.size.height + 3),
          new THREE.Vector3(-3, y, o.size.height + 3),
        )
      }
      const material = hoveredTag || hoveredFacet
        ? new THREE.LineBasicMaterial({ color: ca.color, transparent: true, opacity: 0.9, depthWrite: false })
        : new THREE.LineDashedMaterial({ color: ca.color, transparent: true, opacity: 0.9, dashSize: 5, gapSize: 4, depthWrite: false })
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material)
      if (!hoveredTag && !hoveredFacet) outline.computeLineDistances()
      outline.userData.tagPerspectiveOutline = outlineId
      unit.add(outline)
    }

    const labels = managed
      ? (pinnedFacet?.labels ?? []).map((value) => ({ id: value.id, color: facetColor(value), text: value.label }))
      : pinnedTag.labels.map((tag) => ({ id: tag.tagId, color: resolveTagColor(tag.tagId, this.data.tags, skin) ?? tag.color, text: tag.value }))
    const overflowCount = managed ? pinnedFacet?.overflowCount ?? 0 : pinnedTag.overflowCount
    if (overflowCount > 0 && labels.length > 0) {
      labels.push({ ...labels[labels.length - 1], text: `+${overflowCount}` })
    }
    let x = 7
    const z = Math.max(5, o.size.height - 21)
    const y = (unit.userData.topY as number | undefined ?? 0) + 0.9
    for (const { id, color, text } of labels) {
      const shown = text.length > 12 ? `${text.slice(0, 11)}…` : text
      const bg = mixColors(skin.connections.labelBg, color, 0.18)
      const width = Math.min(78, approxTextWidth(shown, 9) + 14)
      if (x + width > o.size.width - 5) break
      const plate = this.plate(width, 15, this.pxr(5), this.surface('tagPlate', bg, { depthWrite: false }))
      plate.userData.tagPerspectiveLabel = id
      plate.userData.lod = LOD_SECONDARY
      plate.position.set(x, y, z)
      unit.add(plate)
      const label = this.addText({
        text: shown,
        font: 'inter600',
        size: 9,
        color: readableOn(bg, '#1E1D1B', '#FFFFFF'),
        anchorX: 'center',
        anchorY: 'middle',
      })
      label.userData.lod = LOD_SECONDARY
      label.position.set(x + width / 2, y + 0.1, z + 7.5)
      unit.add(label)
      x += width + 4
    }
  }

  /** Full rebuild when structure/content changed; cheap position sync + ribbon
   * refresh when only placement moved (the drag path). */
  /** Apply several setters with ONE rebuild at the end. Every setter that
   * would rebuild (or rebuild connections) inside `fn` only marks the scene
   * dirty. The mount path configures skin, theme, decor, tag state and data
   * back to back; unbatched, each of those rebuilt the floor + background
   * world from scratch on the 3D entry task (enter3d import.then measured
   * 114-123 ms as one task, view3d quality loop 2026-10-08). */
  batch(fn: () => void): void {
    this.batchDepth++
    try {
      fn()
    } finally {
      this.batchDepth--
      if (this.batchDepth === 0 && this.batchDirty) {
        this.batchDirty = false
        this.rebuild()
      }
    }
  }

  private rebuild(): void {
    if (this.batchDepth > 0) {
      this.batchDirty = true
      return
    }
    if (!this.skin || !this.palette) return
    const sig = this.dataSignature()
    if (sig === this.buildSignature) {
      // positions only — move node/group transforms, rebuild connections + floor stays
      for (const o of this.data.objects) {
        const g = this.nodeGroups.get(o.id)
        if (g) g.position.set(o.position.x, g.position.y, o.position.y)
      }
      for (const grp of this.data.groups) {
        const plate = this.groupPlates.get(grp.id)
        if (plate) {
          const r = this.groupRect(grp)
          const built = plate.userData.rect as Rect | undefined
          if (built && (built.w !== r.w || built.h !== r.h)) {
            // a member drag changed the derived bounds — re-hug the platform
            // (plates are cheap: 2 shapes + label; cards/floor stay untouched)
            this.disposeUnit(plate)
            this.groupPlates.delete(grp.id)
            this.buildPlatform(grp, CAMERA_PRESETS[this.preset].plat)
          } else {
            plate.position.set(r.x, plate.position.y, r.y)
            // same geometry, new origin: keep the built-rect record current
            // (a same-size platform drag left it at the pre-drag origin, so
            // groupInfo().builtRect disagreed with rect — e2e "group
            // platforms" failed whenever the per-member snap kept the size)
            plate.userData.rect = { ...r }
          }
        }
      }
      this.buildConnections()
      this.scheduleDecorRefresh()
      this.requestRender()
      return
    }
    this.buildSignature = sig
    const tBuild = performance.now()
    this.clearRoot()
    this.slabGeoUsed.clear()
    this.refreshTagFocusMembership()

    const preset = CAMERA_PRESETS[this.preset]
    const memberOf = new Map<string, Group>()
    for (const g of this.data.groups) for (const id of g.objectIds) memberOf.set(id, g)

    const tFloor = performance.now()
    this.buildFloor()
    const floorMs = performance.now() - tFloor
    for (const g of this.data.groups) this.buildPlatform(g, preset.plat)
    this.cardTextRects.clear()
    this.placeStoreTags()
    for (const o of this.data.objects) {
      const perspective = this.objectTagPerspective(o)
      if (perspective.hidden) continue
      const grp = memberOf.get(o.id)
      const baseY = grp ? preset.plat : 0
      const unit = o.type === 'store' ? this.buildStandee(o, baseY) : this.buildCard(o, baseY, preset.depth)
      this.addTagPerspectiveDecorations(unit, o)
      this.applyUnitOpacity(unit, perspective.alpha)
      unit.position.set(o.position.x, 0, o.position.y)
      unit.userData.baseY = baseY
      this.nodeGroups.set(o.id, unit)
      this.root.add(unit)
    }
    this.connLayer = new THREE.Group()
    this.connLayer.position.y = preset.plat + CONNECTION_LIFT
    this.root.add(this.connLayer)
    // inline: buildDecor below keeps its props off the PLACED label plates
    this.buildConnections('inline')
    this.buildConnProgramWarmers()
    const tDecor = performance.now()
    this.buildDecor()
    const decorMs = performance.now() - tDecor
    // slab sizes this build no longer uses (a resized card, a theme flip)
    for (const [key, geo] of this.slabGeoCache) {
      if (this.slabGeoUsed.has(key)) continue
      geo.dispose()
      this.slabGeoCache.delete(key)
    }
    if (this.litRig) {
      const lighting = this.theme3d?.environment?.lighting
      const bb = this.contentBounds()
      if (lighting) {
        // City dusk: the city background swaps the studio key for a LOW warm
        // dusk sun — longer PCFSoft shadows fall out of the elevation for
        // free; fill drops so the maquette grades warm-to-cool. mountLightRig
        // retunes the existing rig in place — no allocation churn.
        const dusk = this.bgWorldBuilt === 'city'
        const tuned = dusk
          ? {
              ...lighting,
              sun: {
                ...(lighting.sun ?? {}),
                color: '#FFC384',
                elevationDeg: 22,
                intensity: (lighting.sun?.intensity ?? 2.2) * 0.95,
              },
              ambient: {
                ...(lighting.ambient ?? {}),
                skyColor: '#FFE6C8',
                groundColor: '#B9A48C',
                intensity: (lighting.ambient?.intensity ?? 0.55) * 0.72,
              },
            }
          : lighting
        this.litRig = mountLightRig(this.scene, this.litRig, tuned)
        this.fitSunShadow(bb)
      }
    }
    this.updateNodeLod() // apply the projected-size LOD to the freshly built nodes
    this.buildTimings = {
      totalMs: performance.now() - tBuild,
      floorMs,
      decorMs,
      builds: this.buildTimings.builds + 1,
      firstFrameMs: 0,
      compileMs: 0,
      postFirstMs: 0,
      postFirstShadowMs: 0,
      postFirstBuild: -1,
      postFirstComposed: false,
    }
    // every build measures its OWN first presented frame (with or without
    // the post stack) — never the previous build's number
    this.armFirstFrameProbe()
    this.firstFramePending = true
    this.scheduleCompile()
    this.requestRender()
  }

  /** Projected-size LOD: hide a node's readable decorations once
   * its on-screen width falls below readability — dropping it from BOTH the draw
   * and troika-text passes where nobody could read it. Recomputed only when the
   * camera SETTLES (frameTick edge) or after a build/resize, never per frame, so
   * it's a handful of multiplies per node at rest. Toggles `.visible` only. */
  private updateNodeLod(): void {
    if (this.nodeGroups.size === 0) return
    const pose = this.rig.getPose()
    const vh = this.renderer.getSize(this._lodSize).y
    const pxPerWorld = vh / (2 * pose.distance * Math.tan((pose.fov / 2) * (Math.PI / 180)))
    // decor is garnish: drop the whole layer once a ~15-world-px prop would
    // project under ~5 screen px (fit-all on huge boards)
    if (this.decorBuild) {
      const visible = pxPerWorld >= 0.35
      if (this.decorBuild.group.visible !== visible) {
        this.decorBuild.group.visible = visible
        this.shadowsDirty = true // props cast shadows
      }
    }
    // The base (edfc9c6f7) projected-size rule, nothing else: a far-title
    // mode and a badge grow/hide rule lived here (view3d quality loop 3 r2 /
    // pass "labels") and were removed on the user's decision of 2026-10-10
    // (shape font, font size and icon regressed against the base).
    let changed = false
    let casterToggled = false
    for (const unit of this.nodeGroups.values()) {
      const size = (unit.userData.lodSize as number | undefined) ?? 200
      const projW = size * pxPerWorld
      const showSecondary = projW >= this.lodSecondaryPx
      const showPrimary = projW >= this.lodPrimaryPx
      for (const child of unit.children) {
        const tier = child.userData.lod as number | undefined
        if (tier === undefined) continue
        const want = tier === LOD_SECONDARY ? showSecondary : showPrimary
        if (child.visible !== want) {
          child.visible = want
          changed = true
          if (!casterToggled) child.traverse((c) => (casterToggled ||= c.castShadow))
        }
      }
    }
    if (this.applyConnLabelScale()) changed = true
    // …and what each shows there: a crowded label comes back whole (or
    // longer) when another framing gives it room (TASK 2). Not mid-glide: the
    // wheel calls this on every event while the dolly is still easing, and
    // the glide's own settle edge comes back here once it lands.
    if (!this.rig.isAnimating() && this.resolveConnLabelVisibility()) changed = true
    // The LOD tiers are text and flat chips, the connection labels are
    // plates — none of them casts a shadow, so a settle that only re-tiers
    // them is a CAMERA frame. requestRender() marked the cached shadow map
    // dirty on every camera settle (and after benchFrames), so the frame
    // after a settle re-rendered every caster for a pure camera move — a
    // candidate for the loop4-r3-dpr2 first-orbit 35.6 ms hitch, which did
    // NOT reproduce in three later DPR 2 runs (loop4-r3-scene-a/b/c: 0
    // hitches), so it is removed as a cost, not claimed as the cause. A tier
    // that does carry a caster still re-renders it.
    if (casterToggled) this.shadowsDirty = true
    if (changed) this.requestCameraRender()
  }

  /** A material leaving the scene is RETIRED, not disposed: three destroys a
   * program the moment its last material is disposed, so disposing the old
   * build before the new one acquired its programs threw away every program
   * the new build was about to ask for again — the full rebuild of a decor
   * pick re-created and re-linked them (`compileSceneFor` + the first-frame
   * `|depth` shadow variant in `postFirstNewPrograms`, view3d-quality
   * 2026-10-08). Retired materials are disposed after the next presented
   * frame, by which time the new build holds every program it needs. */
  private retiredMaterials = new Set<THREE.Material>()

  private retire(mat: THREE.Material | THREE.Material[] | undefined | null): void {
    if (Array.isArray(mat)) for (const m of mat) this.retiredMaterials.add(m)
    else if (mat) this.retiredMaterials.add(mat)
  }

  private flushRetiredMaterials(): void {
    if (this.retiredMaterials.size === 0) return
    for (const m of this.retiredMaterials) m.dispose()
    this.retiredMaterials.clear()
  }

  private clearRoot(): void {
    this.root.traverse((obj) => {
      if (obj.userData.sharedAsset) {
        // Geometry stays cache-owned. A dimmed instance may own a lightweight
        // material clone so changing its opacity never affects sibling assets.
        if (obj.userData.tagPerspectiveMaterialClone) this.retire((obj as THREE.Mesh).material)
        return
      }
      const mesh = obj as THREE.Mesh
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose()
      // `sharedGeometry`: cache-owned buffers (slab / city caches), but the
      // material is this build's own
      if (mesh.geometry && !obj.userData.sharedGeometry) mesh.geometry.dispose()
      this.retire(mesh.material as THREE.Material | THREE.Material[] | undefined)
    })
    this.cityHolder = null
    this.billboards = []
    this.floorTextured = false
    for (const t of this.texts) t.dispose()
    this.texts = []
    for (const t of this.connTexts) t.dispose()
    this.connTexts = []
    this.root.clear()
    this.nodeGroups.clear()
    this.groupPlates.clear()
    this.pickables = []
    this.floorFade = []
    this.motionUnits = []
    this.voxelScatter = null
    this.voxelAnimations.clear()
    this.hoveredVoxelId = null
    this.flowUnits = []
    this.floorGridToggle = null
    this.litFloorGrid = null
    if (this.decorBuild) {
      // (disposeDecorBuild's job — materials only — through the retire list)
      this.retire(this.decorBuild.materials)
      this.decorBuild = null
    }
  }

  /** Dispose ONE built unit (a platform plate) without touching the rest of
   * the scene — clearRoot's bookkeeping (pickables, texts, geo/mat) scoped to
   * the unit's subtree. Platforms never register floorFade/motion/flow. */
  private disposeUnit(unit: THREE.Group): void {
    const members = new Set<THREE.Object3D>()
    unit.traverse((o) => members.add(o))
    this.pickables = this.pickables.filter((p) => !members.has(p))
    const kept: Text[] = []
    for (const t of this.texts) {
      if (members.has(t)) t.dispose()
      else kept.push(t)
    }
    this.texts = kept
    unit.traverse((obj) => {
      if (obj.userData.sharedAsset) {
        if (obj.userData.tagPerspectiveMaterialClone) {
          const material = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
          if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
          else material?.dispose()
        }
        return
      }
      const mesh = obj as THREE.Mesh
      if (mesh.geometry && !obj.userData.sharedGeometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else if (mat) mat.dispose()
    })
    this.root.remove(unit)
  }

  // ── materials & shapes ─────────────────────────────────────────────────────

  /** Role-keyed material seam (PBR migration). Unlit profile: byte-identical
   * delegation to `unlit()` — the pinned pixel suites are the proof. The lit
   * branch (per-role physical materials) lands with the Studio flagship; until
   * then a lit theme renders through the same unlit materials (dark launch).
   * Materials stay per-instance: several call sites mutate opacity/transparent
   * after construction (spec opacity, focus dim, accent alpha), so a memoizing
   * factory would alias unrelated meshes. */
  private surface(
    role: SurfaceRole,
    css: string,
    opts: { side?: THREE.Side; depthWrite?: boolean } = {},
  ): THREE.Material {
    const lighting = this.renderProfile === 'lit' ? this.theme3d?.environment?.lighting : null
    if (lighting) return litSurface(role, css, opts, lighting)
    return this.unlit(css, opts)
  }

  private unlit(css: string, opts: { side?: THREE.Side; depthWrite?: boolean } = {}): THREE.MeshBasicMaterial {
    const { color, alpha } = colorAlpha(css)
    return new THREE.MeshBasicMaterial({
      color,
      transparent: alpha < 1,
      opacity: alpha,
      side: opts.side ?? THREE.FrontSide,
      depthWrite: opts.depthWrite ?? alpha >= 1,
    })
  }

  /** A css color as RAW sRGB components (0..1), bypassing three's working-space
   * conversion. Our custom shaders output these verbatim: with NoToneMapping +
   * an sRGB canvas that reproduces the CSS hex EXACTLY — the built-in-material
   * pipeline does its own round-trip, but a raw ShaderMaterial must not. */
  private srgbUniform(css: string): THREE.Color {
    const { color } = colorAlpha(css)
    const c = new THREE.Color()
    c.setStyle(color, THREE.LinearSRGBColorSpace) // "already linear" → no conversion
    return c
  }

  /** Wall material — mixes the kit's front/side wall colors by face normal so
   * the extruded rounded corners blend the two, exactly like the poster look.
   * `band` (pixel-snap themes): a hard lighter strip along the wall's top edge
   * — the pixel-art bevel highlight, posterized (a step, not a gradient). */
  private wallMaterial(front: string, side: string, band?: { h: number; depth: number }): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      // fog: the scene's (clamped) FogExp2 carries a raw-sRGB color (see
      // applyEnvironment), so mixing it with our raw-sRGB outputs stays exact.
      fog: true,
      defines: band ? { PIXEL_BAND: '' } : {},
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uFront: { value: this.srgbUniform(front) },
        uSide: { value: this.srgbUniform(side) },
        uOpacity: { value: 1 },
        uBandTop: { value: band ? band.depth - band.h : 0 },
      },
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        varying vec3 vNormalW;
        varying float vLocalY;
        void main() {
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vLocalY = position.y;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>
        uniform vec3 uFront;
        uniform vec3 uSide;
        uniform float uOpacity;
        uniform float uBandTop;
        varying vec3 vNormalW;
        varying float vLocalY;
        void main() {
          float m = smoothstep(0.25, 0.75, abs(normalize(vNormalW).x));
          vec3 col = mix(uFront, uSide, m);
          #ifdef PIXEL_BAND
          if (vLocalY > uBandTop) col = mix(col, vec3(1.0), 0.22);
          #endif
          gl_FragColor = vec4(col, uOpacity);
          #include <fog_fragment>
        }
      `,
    })
  }

  /** Floor-top material: flat fill + the kit's radial dot grid (20px spacing),
   * procedural so it stays crisp at every zoom. An optional theme floorTexture
   * tiles under the dots at the same 20-unit pitch (raw-sRGB passthrough —
   * the texture is set to LinearSRGB so sampling returns authored values). */
  private floorMaterial(bg: string, grid: string, map: THREE.Texture | null = null): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      fog: true,
      defines: {
        ...(map ? { USE_FLOOR_MAP: '' } : {}),
        // pixel-snap themes: the grid dots are square "pixels", not discs
        ...(this.theme3d?.pixelSnap != null ? { PIXEL_DOTS: '' } : {}),
      },
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uBg: { value: this.srgbUniform(bg) },
        uGrid: { value: this.srgbUniform(grid) },
        uMap: { value: map },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>
        uniform vec3 uBg;
        uniform vec3 uGrid;
        uniform float uOpacity;
        #ifdef USE_FLOOR_MAP
        uniform sampler2D uMap;
        #endif
        varying vec3 vWorld;
        void main() {
          vec3 base = uBg;
          #ifdef USE_FLOOR_MAP
          base = texture2D(uMap, vWorld.xz / 20.0).rgb;
          #endif
          vec2 cell = mod(vWorld.xz, 20.0) - 10.0;
          #ifdef PIXEL_DOTS
          float d = max(abs(cell.x), abs(cell.y)); // Chebyshev → square dot
          float dot = 1.0 - smoothstep(1.4, 1.9, d);
          #else
          float d = length(cell);
          float dot = 1.0 - smoothstep(1.0, 1.6, d);
          #endif
          gl_FragColor = vec4(mix(base, uGrid, dot), uOpacity);
          #include <fog_fragment>
        }
      `,
    })
  }

  /** Soft ground shadow for a ROUNDED-RECT caster: an SDF falloff that hugs
   * the slab's real footprint (w×h, corner r) with a `soft` penumbra
   * straddling the edge. A radial blob reads as an OVAL under rectangular
   * cards — drums keep the blob, they are round.
   * Mount on a plane sized (w + 2·soft) × (h + 2·soft), centered. */
  private shadowMaterial(
    w: number,
    h: number,
    r: number,
    css: string,
    alphaMul: number,
    soft: number,
  ): THREE.ShaderMaterial {
    const { alpha } = colorAlpha(css)
    return new THREE.ShaderMaterial({
      fog: true,
      transparent: true,
      depthWrite: false,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uColor: { value: this.srgbUniform(css) },
        uAlpha: { value: alpha * alphaMul },
        uOpacity: { value: 1 },
        uHalf: { value: new THREE.Vector2(Math.max(0, w / 2 - r), Math.max(0, h / 2 - r)) },
        uRadius: { value: r },
        uSoft: { value: soft },
        uSize: { value: new THREE.Vector2(w + 2 * soft, h + 2 * soft) },
      },
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>
        uniform vec3 uColor;
        uniform float uAlpha;
        uniform float uOpacity;
        uniform vec2 uHalf;
        uniform float uRadius;
        uniform float uSoft;
        uniform vec2 uSize;
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * uSize;
          vec2 q = abs(p) - uHalf;
          float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
          float fall = 1.0 - smoothstep(-uSoft, uSoft, d);
          gl_FragColor = vec4(uColor, uAlpha * uOpacity * fall);
          #include <fog_fragment>
        }
      `,
    })
  }

  /** Rounded-rect Shape in board coords (shape.y = −world.y): origin top-left,
   * spans x∈[0,w], world-y∈[0,h]. Per-corner radii for the status bar. */
  /** Pixel-staircase step size for a w×h plate (in pixel-grid units, scaled by
   * the plate's smaller dimension, capped so small tags keep a subtle notch). */
  private pixelStep(w: number, h: number): number {
    const ps = this.theme3d?.pixelSnap ?? 2
    const k = Math.max(1, Math.min(4, Math.round(Math.min(w, h) / (16 * ps))))
    const s = k * ps
    return Math.min(w, h) > 6 * s ? s : 0
  }

  /** Pixel-art stepped-corner outline (the 3D face of drawPixelArtRect): each
   * corner cut by a 2-step staircase of `s` instead of an arc. */
  private pixelShape(w: number, h: number, s: number): THREE.Shape {
    const y = (wy: number) => -wy
    const c = 2 * s
    const p = new THREE.Shape()
    p.moveTo(c, y(0))
    p.lineTo(w - c, y(0))
    p.lineTo(w - c, y(s))
    p.lineTo(w - s, y(s))
    p.lineTo(w - s, y(c))
    p.lineTo(w, y(c))
    p.lineTo(w, y(h - c))
    p.lineTo(w - s, y(h - c))
    p.lineTo(w - s, y(h - s))
    p.lineTo(w - c, y(h - s))
    p.lineTo(w - c, y(h))
    p.lineTo(c, y(h))
    p.lineTo(c, y(h - s))
    p.lineTo(s, y(h - s))
    p.lineTo(s, y(h - c))
    p.lineTo(0, y(h - c))
    p.lineTo(0, y(c))
    p.lineTo(s, y(c))
    p.lineTo(s, y(s))
    p.lineTo(c, y(s))
    p.closePath()
    return p
  }

  /** Board-dressing outline: pixel-snap themes swap the rounded corners for the
   * 2-step pixel staircase (2D drawPixelArtRect parity — the voxel top face);
   * everything else keeps the kit's rounded rect. */
  private boardShape(w: number, h: number, r: number | { tl: number; tr: number; br: number; bl: number }): THREE.Shape {
    if (this.theme3d?.pixelSnap != null && typeof r === 'number') {
      const s = this.pixelStep(w, h)
      if (s > 0) return this.pixelShape(w, h, s)
      return this.roundedShape(w, h, 0)
    }
    return this.roundedShape(w, h, r)
  }

  private roundedShape(w: number, h: number, r: number | { tl: number; tr: number; br: number; bl: number }): THREE.Shape {
    const rr = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : r
    const y = (wy: number) => -wy
    const s = new THREE.Shape()
    s.moveTo(rr.tl, y(0))
    s.lineTo(w - rr.tr, y(0))
    s.quadraticCurveTo(w, y(0), w, y(rr.tr))
    s.lineTo(w, y(h - rr.br))
    s.quadraticCurveTo(w, y(h), w - rr.br, y(h))
    s.lineTo(rr.bl, y(h))
    s.quadraticCurveTo(0, y(h), 0, y(h - rr.bl))
    s.lineTo(0, y(rr.tl))
    s.quadraticCurveTo(0, y(0), rr.tl, y(0))
    return s
  }

  /** Flat plate lying on the board (top-left origin like roundedShape). */
  private plate(w: number, h: number, r: number | { tl: number; tr: number; br: number; bl: number }, material: THREE.Material): THREE.Mesh {
    const geo = new THREE.ShapeGeometry(this.boardShape(w, h, r))
    geo.rotateX(-Math.PI / 2)
    return new THREE.Mesh(geo, material)
  }

  /** Ring band (outer rounded rect minus inner) — borders and selection rings.
   * Pixel-snap themes: outer AND inner take the same staircase step so the
   * band reads as the 2D pixel border with its stepped bevel corners. */
  private ringPlate(w: number, h: number, r: number, inset: number, material: THREE.Material): THREE.Mesh {
    const pixelS = this.theme3d?.pixelSnap != null ? this.pixelStep(w, h) : 0
    const outer = pixelS > 0 ? this.pixelShape(w, h, pixelS) : this.roundedShape(w, h, r)
    const innerShape =
      pixelS > 0
        ? this.pixelShape(w - 2 * inset, h - 2 * inset, pixelS)
        : this.roundedShape(w - 2 * inset, h - 2 * inset, Math.max(1, r - inset))
    const hole = new THREE.Path()
    const pts = innerShape.getPoints(24).map((p) => new THREE.Vector2(p.x + inset, p.y - inset))
    hole.setFromPoints(pts)
    outer.holes.push(hole)
    const geo = new THREE.ShapeGeometry(outer)
    geo.rotateX(-Math.PI / 2)
    return new THREE.Mesh(geo, material)
  }

  /** Extruded slab in world frame: base y=0, top y=depth (top-left origin). */
  private slab(
    w: number,
    h: number,
    r: number,
    depth: number,
    capMaterial: THREE.Material,
    sideMaterial: THREE.Material,
  ): THREE.Mesh {
    if (this.renderProfile === 'lit') {
      // cached by every input the geometry depends on (boardShape reads the
      // theme's pixel-snap); the mesh is marked so teardown keeps the buffers
      const snap = this.theme3d?.pixelSnap != null ? this.pixelStep(w, h) : -1
      const key = `${w}|${h}|${r}|${depth}|${snap}`
      this.slabGeoUsed.add(key)
      const hit = this.slabGeoCache.get(key)
      if (hit) {
        const mesh = new THREE.Mesh(hit, [capMaterial, sideMaterial])
        mesh.userData.sharedGeometry = true
        return mesh
      }
      // Ceramic read: a small bevel catches the key light along every edge.
      // bevelOffset pulls the core in by the bevel size so the FOOTPRINT stays
      // exactly w×h — layouts, labels and pixel probes keep their geometry.
      const bevel = Math.min(1.8, depth * 0.35)
      // Porcelain needs a genuinely smooth roundover: 24 arc segments per
      // corner + 4 bevel rings keep the silhouette curve and the bevel
      // shading band clean at close-up zoom (8/2 reads faceted).
      // Cost is vertices only, zero extra draw calls.
      const raw = new THREE.ExtrudeGeometry(this.boardShape(w, h, r), {
        depth,
        curveSegments: 24,
        bevelEnabled: true,
        bevelThickness: bevel,
        bevelSize: bevel,
        bevelOffset: -bevel,
        bevelSegments: 4,
      })
      // Extrude bevels grow BOTH ends (z ∈ [-bevel, depth+bevel]) — slide the
      // geometry so the CAP tops out exactly at `depth`: the content layer at
      // depth+0.15/0.3 keeps its layering, and the lip pokes harmlessly into
      // whatever the slab stands on.
      raw.translate(0, 0, -bevel)
      const geo = toCreasedNormals(raw, (50 * Math.PI) / 180)
      raw.dispose()
      geo.rotateX(-Math.PI / 2)
      this.slabGeoCache.set(key, geo)
      const mesh = new THREE.Mesh(geo, [capMaterial, sideMaterial])
      mesh.userData.sharedGeometry = true
      return mesh
    }
    const geo = new THREE.ExtrudeGeometry(this.boardShape(w, h, r), {
      depth,
      bevelEnabled: false,
      curveSegments: 8,
    })
    geo.rotateX(-Math.PI / 2)
    return new THREE.Mesh(geo, [capMaterial, sideMaterial])
  }

  private addText(spec: Parameters<typeof makeText>[0], bucket: Text[] = this.texts): Text {
    const t = makeText(spec, () => this.requestRender())
    bucket.push(t)
    return t
  }

  // ── scene decoration ───────────────────────────────────────────────────────

  /** (Re)build the decoration layer from the pure placement engine. Runs at
   * the END of a full rebuild (connection routes must exist for the
   * near-connection affinity) and via the debounced fast-path refresh. */
  /** Fit the sun's shadow camera to the content bounds AND the decor layer.
   * Runs from the full rebuild (after the rig retune) and after every
   * decor-only build (settle / refresh), whose props may stand elsewhere on
   * the desk band — see `fitShadowCamera`'s `cover`. */
  private fitSunShadow(bb = this.contentBounds()): void {
    const lighting = this.theme3d?.environment?.lighting
    if (!this.litRig || !lighting) return
    const dusk = this.bgWorldBuilt === 'city'
    let cover: THREE.Box3 | null = null
    const group = this.decorBuild?.group
    if (group) {
      group.updateWorldMatrix(true, true)
      cover = new THREE.Box3().setFromObject(group)
    }
    fitShadowCamera(
      this.litRig,
      { x: bb.cx - bb.width / 2, y: bb.cz - bb.height / 2, width: bb.width, height: bb.height },
      {
        enabled: this.renderProfile === 'lit' && lighting.shadows?.enabled !== false,
        mapSize: lighting.shadows?.mapSize,
        intensity: dusk ? Math.min(0.8, (lighting.shadows?.opacity ?? 0.55) + 0.09) : lighting.shadows?.opacity,
        cover,
      },
    )
  }

  private buildDecor(): void {
    if (this.decorBuild) {
      this.root.remove(this.decorBuild.group)
      this.retire(this.decorBuild.materials) // see retiredMaterials
      // the per-build contact-blob quads (decor/build.ts) — the archetype
      // geometry stays cache-owned
      for (const g of this.decorBuild.geometries) g.dispose()
      this.decorBuild = null
    }
    const decor = this.sceneDecor
    if (!decor) return
    const pack = getDecorPack(decor.packId)
    if (!pack) return
    // The Blender meshes (decor/glbAssets.ts) arrive once per page. Until they
    // settle the layer is NOT built: a fallback build would be compiled, shown
    // for a few frames and thrown away. The compile gate waits on the same
    // promise, so the first presented frame already wears the final props.
    if (!this.decorAssetsSettled) {
      if (!this.decorAssetsPending) {
        // Bounded: a slow or hung fetch must not leave the desk bare (or hold
        // the compile gate) — after DECOR_ASSET_WAIT_MS the procedural props
        // are built, and a late arrival rebuilds them from the GLBs (the
        // archetype cache is keyed on the asset version).
        const loading = loadDecorAssets()
        const budget = new Promise<void>((r) => setTimeout(r, DECOR_ASSET_WAIT_MS))
        this.decorAssetsPending = Promise.race([loading, budget]).then(() => {
          this.decorAssetsSettled = true
          this.decorAssetsPending = null
          if (this.disposed) return
          this.timedTask('decor-settle', () => {
            this.buildDecor()
            this.updateNodeLod() // decor visibility follows the projected size
          })
          this.scheduleCompile()
          this.requestRender()
        })
        void loading.then(() => {
          if (!this.disposed && this.decorAssetsSettled && this.decorBuild) this.scheduleDecorRefresh()
        })
      }
      return
    }
    const lit = this.renderProfile === 'lit'
    // the shared WORKBENCH props ride along on lit themes (the wood desk
    // plane exists there); unlit boards keep pack-only decor
    const archetypes = lit ? [...pack.archetypes, ...DESK_ARCHETYPES] : pack.archetypes
    const b = this.contentBounds()
    // desk level — in the city the desk props stand on the civic podium,
    // which fills the gap up to the slab's bottom (buildCityPodium)
    const deskLift =
      -(CAMERA_PRESETS[this.preset].floorD + 16) + 0.3 + (this.bgWorldBuilt === 'city' ? CITY_PODIUM_H : 0)
    const placementInput: PlacementInput = {
      // the default framing the desk showcase must read in (loop 3 r2: the
      // flag stood under the left panel in a window tuned without it)
      view: lit ? this.showcaseView(deskLift) : undefined,
      archetypes,
      density: decor.density ?? 'normal',
      seed: decor.seed ?? 1,
      bounds: { x: b.cx - b.width / 2, y: b.cz - b.height / 2, w: b.width, h: b.height },
      pad: this.lastFloorPad,
      fractureBand: this.lastFractureBand,
      // a drum's footprint is its pad ring and the name tag in front of it
      // (buildStandee), which can reach past the shape rect — leaves keep
      // their clearance from what is drawn, not from the 2D box
      nodes: this.data.objects.map((o) => {
        const r = this.objectRect(o)
        if (o.type !== 'store') return { id: o.id, type: o.type, rect: r }
        const cx = r.x + r.w / 2
        const cz = r.y + r.h / 2
        const tag = this.storeTag(o, r)
        const x0 = Math.min(r.x, cx - PAD_R, tag?.x ?? Infinity)
        const z0 = Math.min(r.y, cz - PAD_R, tag?.y ?? Infinity)
        const x1 = Math.max(r.x + r.w, cx + PAD_R, tag ? tag.x + tag.w : -Infinity)
        const z1 = Math.max(r.y + r.h, cz + PAD_R, tag ? tag.y + tag.h : -Infinity)
        return { id: o.id, type: o.type, rect: { x: x0, y: z0, w: x1 - x0, h: z1 - z0 } }
      }),
      groups: this.data.groups.map((g) => this.groupRect(g)),
      connections: [...this.connGeoms.values()].map((geom) => ({ points: samplePath(geom, 12) })),
      // a copy: a sliced label pass still running moves and adds boxes in
      // place (runLabelJob compares it at its commit — decorAvoidSig)
      avoid: this.connLabelBoxes.map((b) => ({ ...b })),
      deskBand: lit ? 150 : undefined,
      // the lamp's foot (workbench only): no prop stands on it, and the
      // greenery zone gathers beside it (quality pass "layout")
      lamp: this.lampFoot ?? undefined,
      // the desk is not the same place in every world: none in the void, and
      // in the city only the bare apron inside the city hole — desk-scale
      // props among the maquette buildings were the giant moose and the leaf
      // through a wall (view3d quality loop 3, city-wide / city-leaf)
      world: this.backgroundWorld(),
    }
    const placed = placeDecor(placementInput)
    this.decorAvoidSig = labelBoxesSig(placementInput.avoid ?? [])
    this.lastDecorInput = { ...placementInput, archetypes: archetypes.map((a) => a.id) }
    const build = buildDecorMeshes({ ...pack, archetypes }, placed, {
      lit,
      platformLift: CAMERA_PRESETS[this.preset].plat,
      // desk level: the workbench plane sits 16 px under the slab bottom
      deskLift,
    })
    // decor rides the 2D↔3D morph exactly like the board dressing
    for (const m of build.materials) this.regFloorFade(m, 1)
    this.decorBuild = build
    this.root.add(build.group)
    this.applyFloorAlpha()
    // a desk prop outside the content bounds must still cast (the full
    // rebuild refits again after its rig retune)
    this.fitSunShadow()
  }

  /** The board's DEFAULT framing as plain numbers for `placeDecor`: the pose
   * fit-to-screen lands on (every node box inside the canvas minus the
   * floating chrome) and that unobstructed rect. Null without a host that
   * measures its chrome (share viewer, tests) — placement then keeps its
   * legacy window. */
  /** The chrome insets the default framing is fitted against: the last
   * fit's, else ONE host measurement per rebuild. The host's measurement
   * hit-tests the page (canvasSafeArea: elementFromPoint) — ~30 ms per call
   * in the loop4 decor-pick profile — and both the label room estimate
   * (connLabelWantK) and the desk showcase (showcaseView) need it. */
  private chromeInsets(): CameraViewportInsets {
    if (this.lastFitInsets) return this.lastFitInsets
    // reused only inside the same build and the same burst of work — a
    // later decor refresh re-measures (a panel may have opened since)
    const builds = this.buildTimings.builds
    const now = performance.now()
    const memo = this.insetsMemo
    if (memo && memo.builds === builds && now - memo.at < 250) return memo.insets
    const insets = this.safeAreaProvider?.() ?? {}
    this.insetsMemo = { builds, at: now, insets }
    return insets
  }

  private insetsMemo: { builds: number; at: number; insets: CameraViewportInsets } | null = null

  private showcaseView(deskY: number): ShowcaseView | undefined {
    if (!this.safeAreaProvider) return undefined
    const points = this.nodeFitBoxes().flatMap((box) => box.corners)
    if (points.length === 0) return undefined
    const m = this.chromeInsets()
    const insets = { left: m.left ?? 0, right: m.right ?? 0, top: m.top ?? 0, bottom: m.bottom ?? 0 }
    const vp = this.rig.getViewport()
    if (vp.width <= 1 || vp.height <= 1) return undefined
    const pose = this.rig.fitPoseFor(this.preset, this.contentBounds(), points, insets)
    const cam = new THREE.PerspectiveCamera(pose.fov, vp.width / vp.height, 10, 200_000)
    applyPose(cam, pose)
    cam.updateMatrixWorld()
    const viewProj = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    return {
      viewProj: [...viewProj.elements],
      viewport: vp,
      safe: {
        x: insets.left,
        y: insets.top,
        w: Math.max(1, vp.width - insets.left - insets.right),
        h: Math.max(1, vp.height - insets.top - insets.bottom),
      },
      deskY,
    }
  }

  /** Fast-path node drags reposition WITHOUT a rebuild (dataSignature skips
   * positions) — refresh the decor shortly after the last move so props
   * clear the moved card. Cell-hashed placement keeps far props identical. */
  private scheduleDecorRefresh(): void {
    if (!this.sceneDecor) return
    if (this.decorRefreshTimer !== null) clearTimeout(this.decorRefreshTimer)
    this.cancelDecorRefreshIdle()
    this.decorRefreshTimer = setTimeout(() => {
      this.decorRefreshTimer = null
      if (this.disposed) return
      // The refresh is a whole decor rebuild plus a compile gate that holds
      // the render loop: never inside a camera gesture. Scheduled from the
      // enter tail (enterTargetPose / frame() when the chrome moved, a late
      // GLB arrival), it could land in the user's first orbit; an orbit, pan
      // or drag in progress pushes it back until the pointer is released…
      if (this.pointer.mode !== 'idle') {
        this.scheduleDecorRefresh()
        return
      }
      // …and it runs in an idle period (bounded, so it always runs)
      const run = () => {
        this.decorRefreshIdle = null
        if (this.disposed) return
        // …and never before the label placement pass has committed: the
        // props keep off the PLACED plates (connLabelBoxes)
        if (this.pointer.mode !== 'idle' || this.labelJob !== null) {
          this.scheduleDecorRefresh()
          return
        }
        this.timedTask('decor-refresh', () => this.buildDecor())
        this.scheduleCompile()
        this.requestRender()
      }
      if (typeof requestIdleCallback === 'function') this.decorRefreshIdle = requestIdleCallback(run, { timeout: 500 })
      else run()
    }, 300)
  }

  private cancelDecorRefreshIdle(): void {
    if (this.decorRefreshIdle === null) return
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(this.decorRefreshIdle)
    this.decorRefreshIdle = null
  }

  // ── floor ──────────────────────────────────────────────────────────────────

  /** The user's explicit TRAY pick; null (absent or 'default') keeps the
   * theme's own board surface. Consumed by the lit cap only — unlit themes
   * keep their pinned shader board. */
  private trayStyle(): TrayVariant | 'paper-grid' | null {
    const s = this.sceneDecor?.boardStyle
    return !s || s === 'default' ? null : s
  }

  /** Background world beyond the board (lit profile; 'default' → workbench). */
  private backgroundWorld(): 'workbench' | 'city' | 'studio' | 'void' {
    const b = this.sceneDecor?.background
    return !b || b === 'default' ? 'workbench' : b
  }

  /** Mount the city ring under `floor`. A cached geometry (same footprint,
   * same seed) is re-dressed synchronously; otherwise the geometry is built
   * in time slices (buildCityGeometrySliced) and attached when it lands.
   * `cityPending` is part of the compile gate, so the render loop keeps the
   * PREVIOUS frame on screen until the new world is complete and its
   * programs are linked — never a half-built city, never a frozen page. */
  private mountCity(floor: THREE.Group, opts: CityGeometryOpts, makeMat: MakeMat): void {
    const base = JSON.stringify(opts)
    // the cache also keys on WHICH Mont-Royal the geometry wears: a city
    // built on the procedural fallback (the GLB late or failed) is rebuilt
    // once the Blender maquette is in (quality pass "montroyal")
    const cityKey = (glb: boolean): string => `${base}|mount:${glb ? 'glb' : 'procedural'}`
    const key = cityKey(decorAsset('mont-royal') !== null)
    const holder = new THREE.Group()
    holder.name = 'city-holder'
    floor.add(holder)
    this.cityHolder = holder
    if (this.cityGeom?.key === key) {
      this.cityJob = null // a stale job for another city stops at its next slice
      this.cityPending = null
      holder.add(assembleCityBackground(this.cityGeom.geom, makeMat, { sharedGeometry: true }).group)
      return
    }
    let job = this.cityJob
    if (!job || job.key !== base) {
      // The maquette rides the decor GLBs (loadDecorAssets, fetched once per
      // page): the build waits for them under the decor layer's own bound,
      // DECOR_ASSET_WAIT_MS — cityPending is part of the compile gate, which
      // waits on the same fetch for the desk props anyway, so the first
      // presented frame wears the maquette, never a swap. The wait is idle
      // time, not a task: no slice runs before it settles.
      const ready =
        decorAsset('mont-royal') !== null
          ? Promise.resolve()
          : Promise.race([loadDecorAssets(), new Promise<void>((r) => setTimeout(r, DECOR_ASSET_WAIT_MS))])
      const stop = (): boolean => this.disposed || this.cityJob !== next
      const next: { key: string; promise: Promise<CityGeometry | null> } = {
        key: base,
        promise: ready.then(() => (stop() ? null : buildCityGeometrySliced(opts, stop))),
      }
      job = next
      this.cityJob = next
    }
    const owner = job
    const pending: Promise<void> = owner.promise
      .then((geom) => {
        if (!geom || this.disposed) return
        // several floors may wait on ONE job (rebuild bursts): the first
        // handler caches the result, the others only dress their holder
        if (this.cityGeom?.geom !== geom) {
          if (this.cityJob !== owner) {
            // superseded after its last slice ran: never uploaded, drop it
            disposeCityGeometry(geom)
            return
          }
          this.cityJob = null
          // the previous city's meshes went with the clearRoot that started
          // this build, so its buffers have no user left
          if (this.cityGeom) disposeCityGeometry(this.cityGeom.geom)
          // keyed on what it WEARS, not what was asked: a fallback mount
          // built after a failed fetch is rebuilt once the maquette lands
          this.cityGeom = { key: cityKey(geom.mount?.source === 'glb'), geom }
        }
        if (this.cityHolder !== holder) return // a newer floor re-dresses from the cache
        holder.add(assembleCityBackground(geom, makeMat, { sharedGeometry: true }).group)
        this.applyFloorAlpha()
        this.requestRender()
      })
      .catch((err: unknown) => {
        console.warn('[scene3d] city background build failed', err)
      })
      .finally(() => {
        if (this.cityPending === pending) this.cityPending = null
      })
    this.cityPending = pending
  }

  private buildFloor(): void {
    this.bgWorldBuilt = null
    this.cityPending = null // set again by mountCity when this floor wants a city
    // parked until a background that owns a lamp re-aims it (see practicalSpot)
    if (this.practicalSpot) this.practicalSpot.intensity = 0
    const palette = this.palette!
    const preset = CAMERA_PRESETS[this.preset]
    const b = this.contentBounds()
    // theme floor spec — sanitized before it reaches us
    const fs: FloorSpec3D | null =
      this.theme3d?.floorSpec({
        bounds: { x: b.cx - b.width / 2, y: b.cz - b.height / 2, w: b.width, h: b.height },
        dark: palette.dark,
      }) ?? null
    if (fs?.mode === 'none') return // theme supplies ground via environment

    const padX = fs?.pad?.x ?? 88
    const padY = fs?.pad?.y ?? 72
    const radius = fs?.cornerRadius ?? 30
    const floorD = fs?.edge === 'flat' ? 3 : preset.floorD
    const w = b.width + 2 * padX
    const h = b.height + 2 * padY
    const x0 = b.cx - w / 2
    const y0 = b.cz - h / 2
    const floorPs = this.theme3d?.pixelSnap ?? 1
    const fractureBand =
      fs?.scatter?.pattern === 'grid-fracture'
        ? Math.max(
            0,
            Math.round(
              Math.min((fs.scatter.size ?? 8) * 4.5, Math.max(0, padX - 24), Math.max(0, padY - 24)) / floorPs,
            ) * floorPs,
          )
        : 0
    const slabW = w - fractureBand * 2
    const slabH = h - fractureBand * 2
    this.lastFloorPad = { x: padX, y: padY }
    this.lastFractureBand = fractureBand
    this.lampFoot = null
    // world footprint of the slab top (y 0) and the desk level under it —
    // the quality harness samples board vs desk luminance on it
    this.boardBox = { x: x0 + fractureBand, z: y0 + fractureBand, w: slabW, h: slabH, topY: 0, deskY: -floorD - 16 }

    const floor = new THREE.Group()
    floor.position.set(x0, 0, y0)
    /** The board is the BOTTOM layer by construction — explicit renderOrder,
     * not sort luck (see the layering invariant on regFloorFade). */
    const bottom = <T extends THREE.Object3D>(obj: T): T => {
      obj.renderOrder = -10
      return obj
    }

    // slab: dot-grid top cap + stone side walls, hanging below y=0.
    // Every floor material registers for the morph fade: the whole
    // dressing rides floorAlpha so the flat 2D reading shows no board.
    const gridCss = fs?.grid === 'none' ? palette.floorBg : (fs?.gridColor ?? palette.floorGrid)
    // theme floorTexture (meta.assets): tiled under the dots once decoded
    let floorMap: THREE.Texture | null = null
    const ftId = this.env3d?.floorTexture
    const ftDecl = ftId ? this.theme3d?.assets?.[ftId] : undefined
    if (ftId && ftDecl?.kind === 'texture' && this.theme3d) {
      const entry = getLoadedAsset(this.theme3d.themeId, ftId)
      if (entry?.texture) floorMap = this.rawFloorMap(entry.texture)
      else if (entry === undefined) {
        void loadThemeAsset(this.theme3d.themeId, ftId, ftDecl).then((e) => {
          if (e && !this.disposed) {
            this.buildSignature = ''
            this.rebuild()
          }
        })
      }
    }
    const lighting = this.renderProfile === 'lit' ? this.theme3d?.environment?.lighting : null
    // Honest probe: the lit paper board replaces any theme floorTexture, so
    // only report a textured floor when the map actually renders.
    this.floorTextured = !!floorMap && !lighting
    let topMat: THREE.Material
    let wallMat: THREE.Material
    if (lighting) {
      // Lit board: the user's TRAY choice (sceneDecor.boardStyle) picks the
      // cap surface; absent/'default' keeps the theme's warm drafting paper.
      // Every look ships an on/off texture pair riding the same litFloorGrid
      // map-only toggle (extrude UVs are raw world px, so the FIXED repeat
      // keeps the 20-unit pitch exact on any board size — boards.ts mirrors
      // paper.ts's contract).
      const tray = this.trayStyle()
      let pairOn: { map: THREE.Texture; roughnessMap: THREE.Texture }
      let pairOff: { map: THREE.Texture; roughnessMap: THREE.Texture }
      let pairDrag: { map: THREE.Texture; roughnessMap: THREE.Texture }
      let capRough = 0.92
      // env kept LOW on every cap: the ambient IBL is what flattened the
      // board — the lamp's warm pool only reads against a quieter base.
      // 0.18 still leaves the paper at ~90% luminance before the spot even
      // arrives, so the pool clips instead of contrasting; 0.08 recedes the
      // baseline enough for a real gradient.
      let capEnv = 0.08
      let wallCss = palette.floorWallFront
      // The walkable-group platformFill rides the tray look too: the neutral
      // translucent cream (~55 % alpha) covers ~85 % of the visible clay cap
      // and washes the fired terracotta to grey putty.
      // Stash the palette's own default ONCE (the palette object outlives
      // rebuilds — setSkin replaces it wholesale, resetting the stash), then
      // let each look tint it; paper/default restores the stash.
      const pal = palette as Palette3d & { platformFillBase?: string }
      pal.platformFillBase ??= pal.platformFill
      pal.platformFill = pal.platformFillBase
      if (tray && tray !== 'paper-grid') {
        // per-look grid ink (engraved cut vs hairline) + walls matching the
        // cap so the tray reads as one solid object;
        // `fill` re-tints the group platformFill where the neutral wash would
        // hide the cap paint — museum keeps the default (its cap matches).
        const look = {
          wood: { grid: '#4A3420', env: 0.3, wall: '#8A6A44', fill: withAlpha('#C0955C', 0.3) },
          museum: { grid: '#BEB7AA', env: 0.2, wall: '#E9E5DC', fill: null },
          clay: { grid: '#8F5433', env: 0.16, wall: '#A96844', fill: withAlpha('#B26247', 0.3) },
        }[tray]
        // at rest the 100-unit majors only; the full pitch while dragging
        // (boards.ts TraySpec.minors — view3d quality loop 4 r3)
        pairOn = trayTexturesFor(tray, { grid: look.grid, showGrid: fs?.grid !== 'none', minors: false })
        pairDrag = trayTexturesFor(tray, { grid: look.grid, showGrid: fs?.grid !== 'none' })
        pairOff = trayTexturesFor(tray, { grid: look.grid, showGrid: false })
        capRough = 1 // tray roughnessMaps encode absolute bands (boards.ts)
        capEnv = look.env
        wallCss = look.wall
        if (look.fill) pal.platformFill = look.fill
      } else {
        const baseCss = colorAlpha(palette.floorBg).color
        const gridCol = colorAlpha(gridCss).color
        pairOn = paperBoardTextures({ base: baseCss, grid: gridCol, showGrid: fs?.grid !== 'none' })
        pairDrag = pairOn // drafting paper keeps one look
        pairOff = paperBoardTextures({ base: baseCss, grid: gridCol, showGrid: false })
      }
      const active = this.showGrid ? (this.gridDragging ? pairDrag : pairOn) : pairOff
      const cap = new THREE.MeshPhysicalMaterial({
        map: active.map,
        roughnessMap: active.roughnessMap,
        roughness: capRough,
        metalness: 0,
        envMapIntensity: capEnv,
      })
      this.litFloorGrid = { mat: cap, on: pairOn.map, off: pairOff.map, drag: pairDrag.map }
      // uploaded now (a 320-px tile, cached across builds), not on the first
      // frame of the first drag
      if (pairDrag.map !== active.map && !this.contextLost) this.renderer.initTexture(pairDrag.map)
      topMat = cap
      wallMat = litSurface('floorWall', wallCss, {}, lighting)
      this.regFloorFade(topMat, 1)
      this.regFloorFade(wallMat, 1)
    } else {
      const shaderTop = this.floorMaterial(palette.floorBg, this.showGrid ? gridCss : palette.floorBg, floorMap)
      this.floorGridToggle = {
        uniform: shaderTop.uniforms.uGrid as THREE.IUniform<THREE.Color>,
        on: this.srgbUniform(gridCss),
        off: this.srgbUniform(palette.floorBg),
      }
      const shaderWall = this.wallMaterial(
        palette.floorWallFront,
        palette.floorWallSide,
        this.theme3d?.pixelSnap != null ? { h: floorPs * 2, depth: floorD } : undefined,
      )
      this.regFloorFade(shaderTop, 1, shaderTop.uniforms.uOpacity as THREE.IUniform<number>)
      this.regFloorFade(shaderWall, 1, shaderWall.uniforms.uOpacity as THREE.IUniform<number>)
      topMat = shaderTop
      wallMat = shaderWall
    }
    const slab = bottom(this.slab(slabW, slabH, radius, floorD, topMat, wallMat))
    slab.position.set(fractureBand, -floorD, fractureBand)
    if (lighting) slab.receiveShadow = true
    floor.add(slab)

    // The standard board keeps the kit border + 7px inset. A fractured grid
    // deliberately omits those continuous contours: a perfect rectangle would
    // visually seal the surface before the broken cells can continue it.
    if (fractureBand === 0) {
      const borderMat = this.surface('floorRing', palette.floorBorder, { depthWrite: false })
      this.regFloorFade(borderMat, borderMat.opacity)
      const border = bottom(this.ringPlate(slabW, slabH, radius, 1.5, borderMat))
      border.renderOrder = -9 // over the slab, still under all board content
      border.position.set(fractureBand, 0.15, fractureBand)
      floor.add(border)
      const insetMat = this.surface('floorRing', palette.floorInsetRing, { depthWrite: false })
      this.regFloorFade(insetMat, insetMat.opacity)
      const inset = bottom(this.ringPlate(slabW - 3, slabH - 3, Math.max(this.pxr(1), radius - 2), 7, insetMat))
      inset.renderOrder = -9
      inset.position.set(fractureBand + 1.5, 0.12, fractureBand + 1.5)
      floor.add(inset)
    }

    // The WORLD beyond the board (lit profile) — the user's background choice
    // (sceneDecor.background). 'workbench' (default): the wood desk + the
    // brass practical lamp (ref1). 'city': the low-poly maquette ring on the
    // desk around the board (ref3). 'studio': NO desk — a seamless paper
    // floor continuous with the warm cyclorama sweep (buildStudioBackground;
    // the walnut desk laid under it showed in the camera's open quadrant,
    // user 2026-10-12). 'void': bare gradient void — board and props only.
    // The desk plane keeps its long grain + plank seams + board-centered
    // vignette (style review round 3) and receives the key-light shadow; the
    // SDF ground shadow draws above it.
    if (lighting) {
      const world = this.backgroundWorld()
      this.bgWorldBuilt = world
      const deskY = -floorD - 16
      // one material seam for the background builders: a FRESH instance per
      // call (builders mutate .side), riding the 2D↔3D floor fade like every
      // board dressing; the emissive role keeps its glow knobs.
      const makeMat: MakeMat = (role, css, opts = {}) => {
        const m = new THREE.MeshStandardMaterial({
          color: new THREE.Color(css),
          vertexColors: opts.vertexColors ?? false,
          metalness: opts.metalness ?? 0,
          roughness: opts.roughness ?? 0.9,
        })
        if (role === 'decorEmissive') {
          m.emissive = new THREE.Color(opts.emissive ?? css)
          m.emissiveIntensity = opts.emissiveIntensity ?? 1
        }
        this.regFloorFade(m, 1)
        return m
      }
      // the wood desk belongs to the workbench and the city only: the studio
      // world's floor is its own paper (it was laid under the studio too, and
      // its walnut was the studio's foreground — the user's "texture qui
      // reste avec du bois", 2026-10-12)
      if (world === 'workbench' || world === 'city') {
        const deskSize = Math.max(6000, Math.max(w, h) * 6)
        // walnut (WOOD_DESK_BASE): a value step under the board (loop 4 r4).
        // The CITY desk is a pale birch board (CITY_DESK_BASE) — the neutral
        // the city's pavement sits on; same grain tile, same program.
        const city = world === 'city'
        const wood = city ? workbenchTextures(CITY_DESK_BASE, undefined, CITY_DESK_CONTRAST) : workbenchTextures()
        // colour, roughness and relief come from one grain tile (lit/wood.ts),
        // so the dark grain lines sit on the relief. (The colour was ONE
        // stretched 2048 canvas — ~3 units per texel, the "diagonal motion-
        // blur streaks" of loop 4 r4 — held there only by its baked
        // vignette, which is now the overlay below.) The desk is BOARDS
        // (deskBoardsGeometry): each maps a tile row at its own offset and
        // mirror with its tone in a vertex colour — a plane repeating the
        // tile read as "plywood wallpaper" (tp-final-dpr1/workbench-wide.png).
        // Its UVs carry the world scale, so the repeat is 1.
        wood.map.repeat.set(1, 1)
        wood.roughnessMap.repeat.set(1, 1)
        wood.normalMap.repeat.set(1, 1)
        const deskMat = new THREE.MeshStandardMaterial({
          map: wood.map,
          roughnessMap: wood.roughnessMap,
          normalMap: wood.normalMap,
          // the board tones; the cutting mat carries a white colour
          // attribute so the two still share ONE program
          vertexColors: true,
          // a uniform, not a define: the near-flat city board keeps the
          // walnut desk's program
          normalScale: city ? new THREE.Vector2(CITY_DESK_RELIEF, CITY_DESK_RELIEF) : new THREE.Vector2(WOOD_DESK_RELIEF, WOOD_DESK_RELIEF),
          roughness: 1,
          metalness: 0,
        })
        this.regFloorFade(deskMat, 1)
        const desk = new THREE.Mesh(deskBoardsGeometry(deskSize, undefined, city ? CITY_DESK_CONTRAST : 1), deskMat)
        desk.rotation.x = -Math.PI / 2
        desk.position.set(fractureBand + slabW / 2, deskY, fractureBand + slabH / 2)
        desk.receiveShadow = true
        desk.renderOrder = -12 // under the SDF board shadow (-11) and the slab (-10)
        // the desk recedes by a polygon offset: the cutting mat's 0.12 lift
        // and the vignette's 0.05 then never z-fight with it, even zoomed out
        // (24-bit depth, near 10: ~0.2 units of resolution at 6 000)
        deskMat.polygonOffset = true
        deskMat.polygonOffsetFactor = 1
        deskMat.polygonOffsetUnits = 4
        floor.add(desk)
        // the desk VIGNETTE (lit/wood.ts deskVignetteTexture): clear around
        // the board, darker toward the rim — the desk recedes and the
        // maquette owns the light. A low-frequency overlay of its own so the
        // wood tile can repeat; drawn with the material set the card icons
        // already link (map + transparent, no depth write, not tone-mapped),
        // so it adds no program. Transparent: it draws after every opaque
        // desk prop, the cutting mat and the slab, which occlude it by depth
        // (it lies UNDER the mat: 0.05 against the mat's 0.12).
        // Not in the city: the city ring covers the desk beyond its hole, and
        // inside the hole the ramp only muddied the apron the city's desk
        // props stand on (city-flag/city-moose.png, 2026-10-09).
        if (!city) {
          const vigMat = new THREE.MeshBasicMaterial({ map: deskVignetteTexture(), transparent: true, depthWrite: false, toneMapped: false })
          this.regFloorFade(vigMat, 1)
          const vignette = new THREE.Mesh(new THREE.PlaneGeometry(deskSize, deskSize), vigMat)
          vignette.rotation.x = -Math.PI / 2
          vignette.position.set(fractureBand + slabW / 2, deskY + 0.05, fractureBand + slabH / 2)
          vignette.renderOrder = -12
          vignette.userData.deskVignette = true // dev-probe marker
          floor.add(vignette)
        }
        if (world === 'workbench') {
          // VIEW3D QUALITY LOOP 4 r4 — the architect's CUTTING MAT under the
          // board (lit/cuttingMat.ts; workbench-wide.png: "the desk still
          // reads empty … large empty tan areas"): slate green, a 5 cm grid
          // along the slab's edges, CUT_MAT_OVERHANG past it. Its material
          // carries the desk's exact feature set (map + roughness + normal
          // maps + vertex colours — white on the mat, cuttingMatGeometry),
          // so it links no new program.
          const cm = cuttingMatTextures()
          const matMat = new THREE.MeshStandardMaterial({
            map: cm.map,
            roughnessMap: cm.roughnessMap,
            normalMap: cm.normalMap,
            vertexColors: true,
            normalScale: new THREE.Vector2(0.3, 0.3),
            roughness: 1,
            metalness: 0,
          })
          this.regFloorFade(matMat, 1)
          const cutMat = new THREE.Mesh(cuttingMatGeometry({ x: fractureBand, z: fractureBand, w: slabW, h: slabH }), matMat)
          cutMat.position.y = deskY + CUT_MAT_LIFT
          cutMat.receiveShadow = true
          cutMat.renderOrder = -12
          cutMat.userData.cuttingMat = true // dev-probe marker
          floor.add(cutMat)
        }
      }
      if (world === 'city') {
        // seed rides the decor seed (resolveSceneDecor defaults it from the
        // diagram id), so two diagrams never share a skyline
        // hole apron kept TIGHT (+35 a side): with the builder's street
        // margin the first low blocks now stand ~half a card-width off the
        // board edge — the old +60 apron plus a 96 margin left a ~200 px
        // barren desk band that isolated the board from its city (AAA
        // round 3 sev6; ref3's blocks run right up to the trays).
        this.mountCity(
          floor,
          {
            // CITY_HOLE_APRON is shared with placeDecor, which keeps every
            // city desk prop's footprint inside this apron
            hole: {
              x: fractureBand + slabW / 2,
              z: fractureBand + slabH / 2,
              w: slabW + 2 * CITY_HOLE_APRON,
              h: slabH + 2 * CITY_HOLE_APRON,
            },
            radius: Math.max(1800, Math.max(slabW, slabH) * 2.75),
            baseY: deskY,
            seed: (this.sceneDecor?.seed ?? 1) >>> 0,
          },
          makeMat,
        )
        // the CIVIC PODIUM (quality pass "city": the board "sits on bare beige
        // ground with no plinth or transition … floats like a giant crate"):
        // granite filling the 16-unit gap between the desk and the slab's
        // bottom, out to the apron line, with steps down to the street on the
        // camera's two sides. The desk props stand on its top (decorDeskLift).
        // Built here, synchronously (a few hundred triangles), in the city's
        // material — same program, one draw.
        const podium = new THREE.Mesh(
          buildCityPodium({
            slab: { x: fractureBand, z: fractureBand, w: slabW, h: slabH },
            // the whole podium inside the city's hole (the steps apart)
            reach: CITY_HOLE_APRON,
            baseY: deskY,
            stairs: ['+x', '+z'],
          }),
          cityMaterial(makeMat),
        )
        podium.receiveShadow = true // the props' and the board's shadows land on it
        podium.userData.cityPodium = true // dev-probe marker
        floor.add(podium)
      } else if (world === 'studio') {
        const studio = buildStudioBackground({
          // radius sized so the sweep (r = radius/2.5) stands ~2000+ world
          // units out: a smaller shell only wedges the frame's LEFT edge at
          // wide framing, leaving the bare scene background visible above
          // the board. At r ≈ 2000+ the camera sits INSIDE the cove volume at
          // default framing and the graded wall owns the whole up-screen field.
          radius: Math.max(5000, Math.max(w, h) * 5),
          baseY: deskY,
          makeMat,
        })
        // lathe axis ON the board centre (same anchor as the desk + city
        // hole): unpositioned, the shell hugs the floor group's origin —
        // the board's NW corner — so its arc walls only the frame's left
        // and the backdrop loses all symmetry.
        studio.group.position.set(fractureBand + slabW / 2, 0, fractureBand + slabH / 2)
        floor.add(studio.group)
      } else if (world === 'workbench') {
        // floor-local foot position and scale — see the two comments below
        const lampAt: [number, number, number] = [fractureBand + slabW * 0.46, deskY, fractureBand - 35]
        const lampScale = 0.5
        // the plan footprint: the smallest circle along the bearing over the
        // foot disc and the shade's disc (the pool lies between them)
        const [bx, bz] = LAMP_BEARING
        const footR = DESK_LAMP_FOOT_R * lampScale
        const shadeFar = (DESK_LAMP_SHADE_REACH + DESK_LAMP_SHADE_R) * lampScale
        const midAlong = (shadeFar - footR) / 2
        this.lampFoot = {
          x: x0 + lampAt[0] + bx * midAlong,
          z: y0 + lampAt[2] + bz * midAlong,
          r: (shadeFar + footR) / 2,
        }
        const lamp = buildDeskLamp({
          // parked past the board's TOP edge, near centre — the iso camera
          // (azimuth 40°) maps +x/−z to screen-right, so the old right-corner
          // anchor (slabW+260, −80) projected ~500 css px PAST the default
          // crop and the round-2 anchor (0.7·slabW, −200) kept the dome one
          // zoom-out step up-frame. Round-3's 0.5·slabW/−60 STILL beheaded
          // the dome at default framing and sank the base behind the right
          // panel (AAA round 4 sev6) — pulled off the panel (0.46·slabW)
          // and down-screen to the slab lip (−35 keeps the base disc ~8
          // units clear); the rest of the fix is the lamp itself: the
          // builder's gooseneck now hunches the dome LOW over the desk
          // (backgrounds.ts round-4 note), because no legal desk anchor
          // could fit the old straight-mast dome between the top toolbar
          // and the board edge — ref1's golden key is the lamp in shot
          // pouring its pool, not an off-stage glow.
          position: lampAt,
          // scaled UNDER 1 so the brass dome clears the frame-top ray: at
          // full size only the stand entered the crop and the dome — the
          // golden-key icon itself — stayed beheaded above the frame
          // (probe-verified; down-screen is (+x,+z) here, and more +z would
          // park the base ON the board).
          scale: lampScale,
          // shade + spot aim at the DESK around the lamp's own foot, off the
          // board (lamp pass 2026-10-10). Every aim ON the slab printed a
          // pool on the diagram: the old one (0.42·slabW, 0.18·slabH), from
          // a shade hung over the slab only 39 units above it, was the
          // critic's "hot spot just right of Event bus" (+8.5 % over the
          // board median, .probes/lamp) and reached the cards. The aim point
          // sits LAMP_AIM_DIST along LAMP_BEARING, between the foot and the
          // shade (which the builder hangs farther out along the same
          // bearing), so the dome tips back toward its stem and the camera.
          boardCenter: [lampAt[0] + bx * LAMP_AIM_DIST, deskY, lampAt[2] + bz * LAMP_AIM_DIST],
          makeMat,
        })
        floor.add(lamp.group)
        if (lamp.lamp) {
          // The spot is the PERSISTENT practical (see practicalSpot): only
          // its parameters change here, never the scene's light count. It
          // stays shadowless (the key light owns shadows) and every
          // parameter is the lamp spec's own (backgrounds.ts buildDeskLamp):
          // a physically decaying desk lamp that lights its corner of the
          // desk. History: loop 4 replaced a tight 6.2 / 0.4-rad cone (a
          // saturated disc beside Event bus) with a wide decay-0 gradient
          // (0.85 rad, penumbra 1, 1.8-2.3) "warm on the top of the board" —
          // which was still a pool ON the diagram, lighting half the slab at
          // full strength with no falloff (the critic's disc on the cards,
          // lamp pass 2026-10-10). The pool now belongs to the desk.
          const spot = this.practicalSpot
          if (spot) {
            spot.color.set(lamp.lamp.color)
            spot.intensity = lamp.lamp.intensity
            spot.distance = lamp.lamp.distance
            spot.angle = lamp.lamp.angle
            spot.penumbra = lamp.lamp.penumbra
            spot.decay = lamp.lamp.decay
            // the lamp spec is FLOOR-local (the old spot was a child of
            // `floor`); the persistent spot lives in the scene, so lift both
            // ends into world space by the floor's own offset
            spot.position.set(...lamp.lamp.position).add(floor.position)
            spot.target.position.set(...lamp.lamp.target).add(floor.position)
            // no prop stands in the pool (loop 4: a leaf inside it read as a
            // glowing orange smear): the lamp's footprint (lampFoot, above)
            // covers it — a desk-side `avoid` box would not, placement's
            // desk fast path skips `avoid` for clearance <= 3
            spot.updateMatrixWorld()
            spot.target.updateMatrixWorld()
          }
        }
      }
    }

    // left the city (or the lit profile): an in-flight build stops at its
    // next slice; the cached geometry stays for a switch back
    if (this.bgWorldBuilt !== 'city') this.cityJob = null

    // soft ground shadow under the board (kit: blur 38, offset 24/36) — drawn
    // below the depth-writing slab, so it only peeks around the board's edges
    if (fs?.shadow !== false) {
      // rounded-rect SDF matching the slab footprint — a radial blob reads as
      // an oval under the rectangular board (same as for the cards)
      const soft = 26
      // lit: the BOARD's ground shadow anchors the maquette to the desk —
      // at 0.4 it measures Δ9 RGB (~4 %, invisible).
      // Cards keep their own 0.4 contact discipline; this is the slab only.
      const contactMul = this.renderProfile === 'lit' ? 0.7 : 1
      const shadowMat = this.shadowMaterial(slabW, slabH, radius, palette.shadowColor, contactMul, soft)
      this.regFloorFade(shadowMat, 1, shadowMat.uniforms.uOpacity as THREE.IUniform<number>)
      const shadow = bottom(new THREE.Mesh(new THREE.PlaneGeometry(slabW + 2 * soft, slabH + 2 * soft), shadowMat))
      shadow.userData.shadowShape = 'roundedRect' // dev-probe marker
      shadow.renderOrder = -11 // under the slab even while both are transparent mid-fade
      shadow.rotation.x = -Math.PI / 2
      // in the city the board stands on its podium: the shadow lies on the
      // podium's top (its slab-bottom level), not on the buried desk
      const groundY = this.bgWorldBuilt === 'city' ? -floorD + 0.25 : -floorD - 14
      shadow.position.set(fractureBand + slabW / 2 + 24, groundY, fractureBand + slabH / 2 + 36)
      floor.add(shadow)
    }

    // Theme fragments dissolve the board into cubes or flat grid tiles. A
    // grid-fracture retracts the slab so the fragments occupy real missing
    // terrain instead of decorating an intact rectangle.
    if (fs?.scatter) this.addVoxelScatter(floor, w, h, fs.scatter, fractureBand)

    this.root.add(floor)
    this.applyFloorAlpha() // a rebuild mid-morph keeps the current fade state
  }

  /** Decorative terrain fragments around the slab (FloorSpec3D.scatter): one
   * instanced mesh, block-shaded faces baked as vertex colors, deterministic
   * placement (same board → same scatter), fading with the 2D↔3D morph.
   * `grid-fracture` uses shallow rectangular cells which begin flush with the
   * retracted slab and dissolve into sparse pieces. */
  private addVoxelScatter(
    floor: THREE.Group,
    w: number,
    h: number,
    sc: NonNullable<FloorSpec3D['scatter']>,
    fractureBand = 0,
  ): void {
    const count = sc.count ?? 64
    const size = sc.size ?? 8
    const spread = sc.spread ?? 120
    const rise = sc.rise ?? 46
    const ps = this.theme3d?.pixelSnap ?? 1
    const interactive = sc.interactive === true
    const pattern = sc.pattern ?? 'cubes'
    const fracturedGrid = pattern === 'grid-fracture'
    const palette = this.palette!

    // unit cube with the block shading law baked per face: top bright,
    // camera-facing walls mid, side walls dark (instance color multiplies)
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const normals = geo.getAttribute('normal')
    const shades = new Float32Array(normals.count * 3)
    for (let i = 0; i < normals.count; i++) {
      const ny = normals.getY(i)
      const nx = normals.getX(i)
      const f = ny > 0.5 ? 1 : ny < -0.5 ? 0.45 : Math.abs(nx) > 0.5 ? 0.6 : 0.78
      shades[i * 3] = f
      shades[i * 3 + 1] = f
      shades[i * 3 + 2] = f
    }
    geo.setAttribute('color', new THREE.BufferAttribute(shades, 3))

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true })
    this.regFloorFade(mat, 1)
    const mesh = new THREE.InstancedMesh(geo, mat, count)
    mesh.frustumCulled = false // instance transforms exceed the unit-cube bounds
    if (interactive) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

    // deterministic LCG — a rebuild reproduces the exact same scatter
    let seed = 0x8b17c0de
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    const snap = (value: number) => Math.round(value / ps) * ps
    const edgeInset = fracturedGrid ? fractureBand : 0
    const coreW = w - edgeInset * 2
    const coreH = h - edgeInset * 2
    const clustered = fracturedGrid || interactive
    const clusterCount = clustered
      ? fracturedGrid
        ? Math.max(12, Math.min(20, Math.round(count / 6)))
        : Math.max(8, Math.min(16, Math.round(count / 6)))
      : 0
    const clusterRows = clusterCount ? Math.ceil(count / clusterCount) : 0
    const clusters = Array.from({ length: clusterCount }, (_, index) => ({
      side: index % 4,
      along: 0.06 + rand() * 0.88,
      span: size * (fracturedGrid ? 2.5 + rand() * 3.8 : 1.5 + rand() * 2.2),
    }))
    const fragments = new Map<string, VoxelFragment>()
    const voxelIds: string[] = []
    const tint = new THREE.Color()
    const terrainColors = [
      palette.floorBg,
      mixColors(palette.floorBg, palette.floorGrid, 0.42),
      mixColors(palette.floorBg, palette.floorBorder, 0.58),
    ]
    for (let i = 0; i < count; i++) {
      let side: number
      let along: number
      let t: number
      let dist: number
      let dimensions: THREE.Vector3
      let homeY: number
      let rotationY = 0
      if (fracturedGrid) {
        const cluster = clusters[i % clusterCount]
        const row = Math.floor(i / clusterCount)
        t = Math.pow(Math.min(1, (row + rand() * 0.55) / Math.max(1, clusterRows - 0.35)), 1.55)
        side = cluster.side
        const extent = side === 0 || side === 2 ? coreW : coreH
        const alongMin = edgeInset
        along = Math.max(
          alongMin - size,
          Math.min(
            alongMin + extent + size,
            snap(alongMin + cluster.along * extent + (rand() - 0.5) * cluster.span * (0.45 + 1.7 * t)),
          ),
        )

        // Rectangular cells stay broad beside the intact surface, then shrink
        // and separate as the grid loses cohesion. A one-pixel gutter keeps
        // neighbouring pieces visibly distinct even in the dense first row.
        const alongCells = 1 + Math.floor(rand() * (t < 0.28 ? 4 : t < 0.68 ? 3 : 2))
        const acrossCells = 1 + Math.floor(rand() * (t < 0.24 ? 3 : 2))
        const tileAlong = Math.max(ps, snap(alongCells * size - ps))
        const tileAcross = Math.max(ps, snap(acrossCells * size - ps))
        const thickness = Math.max(ps, snap(ps * (1 + Math.floor(rand() * 2))))
        dimensions =
          side === 0 || side === 2
            ? new THREE.Vector3(tileAlong, thickness, tileAcross)
            : new THREE.Vector3(tileAcross, thickness, tileAlong)
        const crossSize = side === 0 || side === 2 ? dimensions.z : dimensions.x
        const jitter = (rand() - 0.5) * size * (0.25 + 1.2 * t)
        dist = snap(crossSize / 2 + Math.max(0, t * t * (edgeInset + spread) + jitter))
        const lift = t < 0.45 ? 0 : snap(rand() * rise * Math.pow((t - 0.45) / 0.55, 2))
        // Top faces start exactly level with the slab; only the sparsest cells
        // lift slightly, preserving the broken-surface reading from the brief.
        homeY = lift - thickness / 2
      } else if (interactive) {
        const cluster = clusters[i % clusterCount]
        const row = Math.floor(i / clusterCount)
        t = Math.min(1, (row + rand() * 0.55) / Math.max(1, clusterRows - 0.35))
        side = cluster.side
        const extent = side === 0 || side === 2 ? w : h
        along = Math.max(
          -size,
          Math.min(
            extent + size,
            snap(cluster.along * extent + (rand() - 0.5) * cluster.span * (0.55 + 1.6 * t)),
          ),
        )
        // The first row straddles the slab edge; successive rows detach into a
        // tapered trail. This reads as missing terrain instead of a uniform halo.
        dist = snap(-size * 0.22 + t * t * spread + rand() * size * (0.25 + 0.6 * t))
        const cube = Math.max(ps, Math.round(((0.55 + rand() * 0.9) * size * (1.1 - 0.6 * t)) / ps) * ps)
        const float = t < 0.42 || rand() < 0.68 ? 0 : rand() * rise * (0.25 + 0.75 * t)
        dimensions = new THREE.Vector3(cube, cube, cube)
        homeY = float + cube / 2
      } else {
        side = Math.floor(rand() * 4)
        along = rand() * (side === 0 || side === 2 ? w : h)
        t = rand() * rand()
        dist = 8 + t * spread
        const cube = Math.max(ps, Math.round(((0.55 + rand() * 0.9) * size * (1.1 - 0.6 * t)) / ps) * ps)
        const float = t < 0.42 || rand() < 0.68 ? 0 : rand() * rise * (0.25 + 0.75 * t)
        dimensions = new THREE.Vector3(cube, cube, cube)
        homeY = float + cube / 2
      }
      const x =
        side === 0 || side === 2
          ? along
          : side === 1
            ? w - edgeInset + dist
            : edgeInset - dist
      const z = side === 0 ? edgeInset - dist : side === 2 ? h - edgeInset + dist : along
      const id = `floor-fragment-${i}`
      const home = new THREE.Vector3(x, homeY, z)
      const transient = this.voxelTransient.get(id)
      const position = home.clone()
      if (transient) position.add(new THREE.Vector3(transient.dx, 0, transient.dz))
      rotationY = transient?.rotationY ?? rotationY
      const outward =
        side === 0
          ? new THREE.Vector2(0, -1)
          : side === 1
            ? new THREE.Vector2(1, 0)
            : side === 2
              ? new THREE.Vector2(0, 1)
              : new THREE.Vector2(-1, 0)
      const interactionSize = Math.max(size, Math.min(Math.max(dimensions.x, dimensions.z), size * 2))
      const fragment: VoxelFragment = {
        id,
        index: i,
        size: interactionSize,
        dimensions,
        home,
        position,
        rotationY,
        outward,
      }
      fragments.set(id, fragment)
      voxelIds.push(id)
      this.voxelQuaternion.setFromAxisAngle(this.voxelUp, rotationY)
      this.voxelScale.copy(dimensions)
      this.voxelMatrix.compose(position, this.voxelQuaternion, this.voxelScale)
      mesh.setMatrixAt(i, this.voxelMatrix)
      const colorRoll = rand()
      const css = fracturedGrid
        ? colorRoll < 0.88
          ? terrainColors[Math.floor(rand() * terrainColors.length)]
          : mixColors(palette.floorBg, sc.colors[Math.floor(rand() * sc.colors.length)], palette.dark ? 0.36 : 0.28)
        : sc.colors[i % sc.colors.length]
      tint.setStyle(colorAlpha(css).color)
      mesh.setColorAt(i, tint)
    }
    for (const id of this.voxelTransient.keys()) if (!fragments.has(id)) this.voxelTransient.delete(id)
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.userData.voxelScatter = count // dev-probe marker
    mesh.userData.voxelIds = voxelIds
    mesh.userData.voxelInteractive = interactive
    mesh.userData.voxelPattern = pattern
    this.voxelScatter = { mesh, floor, fragments, interactive }
    if (interactive) this.pickables.push(mesh)
    floor.add(mesh)
  }

  private updateVoxelFragment(fragment: VoxelFragment): void {
    const live = this.voxelScatter
    if (!live) return
    const hoverScale = this.hoveredVoxelId === fragment.id ? 1.1 : 1
    this.voxelQuaternion.setFromAxisAngle(this.voxelUp, fragment.rotationY)
    this.voxelScale.copy(fragment.dimensions).multiplyScalar(hoverScale)
    this.voxelMatrix.compose(fragment.position, this.voxelQuaternion, this.voxelScale)
    live.mesh.setMatrixAt(fragment.index, this.voxelMatrix)
    live.mesh.instanceMatrix.needsUpdate = true
  }

  /** The connection under the pointer: its label shows WHOLE while it rests
   * there — the way an abbreviated or hidden label (TASK 2) is read. */
  private setConnLabelHover(id: string | null): void {
    if (id === this.connLabelHoverId) return
    this.connLabelHoverId = id
    if (this.resolveConnLabelVisibility()) this.requestCameraRender()
  }

  private setVoxelHover(id: string | null): void {
    if (id === this.hoveredVoxelId) return
    const live = this.voxelScatter
    const previous = this.hoveredVoxelId
    this.hoveredVoxelId = id
    if (live && previous) {
      const fragment = live.fragments.get(previous)
      if (fragment) this.updateVoxelFragment(fragment)
    }
    if (live && id) {
      const fragment = live.fragments.get(id)
      if (fragment) this.updateVoxelFragment(fragment)
    }
    this.requestRender()
  }

  private animateVoxel(id: string, to: THREE.Vector3, toRotation: number, hop: number, duration: number): void {
    const fragment = this.voxelScatter?.fragments.get(id)
    if (!fragment) return
    if (this.rig.prefersReducedMotion()) {
      fragment.position.copy(to)
      fragment.rotationY = toRotation
      this.updateVoxelFragment(fragment)
      this.requestRender()
      return
    }
    this.voxelAnimations.set(id, {
      from: fragment.position.clone(),
      to: to.clone(),
      fromRotation: fragment.rotationY,
      toRotation,
      hop,
      start: performance.now(),
      duration,
    })
    this.requestRender()
  }

  private kickVoxel(id: string): void {
    const fragment = this.voxelScatter?.fragments.get(id)
    if (!fragment) return
    const current = this.voxelTransient.get(id) ?? {
      dx: fragment.position.x - fragment.home.x,
      dz: fragment.position.z - fragment.home.z,
      rotationY: fragment.rotationY,
    }
    const step = Math.max(this.theme3d?.pixelSnap ?? 1, fragment.size * 1.35)
    const next = {
      dx: current.dx + fragment.outward.x * step,
      dz: current.dz + fragment.outward.y * step,
      rotationY: current.rotationY + Math.PI / 2,
    }
    this.voxelTransient.set(id, next)
    this.animateVoxel(
      id,
      new THREE.Vector3(fragment.home.x + next.dx, fragment.home.y, fragment.home.z + next.dz),
      next.rotationY,
      fragment.size * 1.4,
      360,
    )
  }

  private settleVoxel(id: string): void {
    const fragment = this.voxelScatter?.fragments.get(id)
    if (!fragment) return
    const current = this.voxelTransient.get(id) ?? {
      dx: fragment.position.x - fragment.home.x,
      dz: fragment.position.z - fragment.home.z,
      rotationY: fragment.rotationY,
    }
    const quarterTurn = Math.PI / 2
    current.rotationY = Math.round(fragment.rotationY / quarterTurn) * quarterTurn
    this.voxelTransient.set(id, current)
    this.animateVoxel(
      id,
      new THREE.Vector3(fragment.home.x + current.dx, fragment.home.y, fragment.home.z + current.dz),
      current.rotationY,
      0,
      220,
    )
  }

  private stepVoxelFragments(now: number): boolean {
    if (this.voxelAnimations.size === 0) return false
    const live = this.voxelScatter
    if (!live) {
      this.voxelAnimations.clear()
      return false
    }
    for (const [id, animation] of this.voxelAnimations) {
      const fragment = live.fragments.get(id)
      if (!fragment) {
        this.voxelAnimations.delete(id)
        continue
      }
      const t = Math.min(1, (now - animation.start) / animation.duration)
      const eased = designEase(t)
      fragment.position.set(
        animation.from.x + (animation.to.x - animation.from.x) * eased,
        animation.from.y + (animation.to.y - animation.from.y) * eased + Math.sin(Math.PI * t) * animation.hop,
        animation.from.z + (animation.to.z - animation.from.z) * eased,
      )
      fragment.rotationY = animation.fromRotation + (animation.toRotation - animation.fromRotation) * eased
      this.updateVoxelFragment(fragment)
      if (t >= 1) this.voxelAnimations.delete(id)
    }
    return this.voxelAnimations.size > 0
  }

  // ── platforms (standard groups) ────────────────────────────────────────────

  private buildPlatform(g: Group, plat: number): void {
    const palette = this.palette!
    const skin = this.skin!
    const r = this.groupRect(g)
    const selected = this.selectedIds.has(g.id)
    const unit = new THREE.Group()
    unit.position.set(r.x, 0, r.y)
    unit.userData.topY = plat
    unit.userData.rect = { ...r } // built geometry — fast-path resize detection
    unit.userData.groupSelected = selected // dev-probe marker

    const fill = this.plate(r.w, r.h, this.pxr(14), this.surface('platform', g.fillTransparent ? withAlpha(palette.platformFill, 0) : palette.platformFill, { depthWrite: false }))
    fill.position.y = plat
    fill.userData.pick = { kind: 'group', id: g.id } satisfies PickTarget
    if (this.renderProfile === 'lit') fill.receiveShadow = true
    unit.add(fill)
    this.pickables.push(fill)

    // selected group = the 2D selection stroke, drawn thicker (2D parity)
    const border = this.ringPlate(
      r.w,
      r.h,
      this.pxr(14),
      selected ? 2.5 : 1.5,
      this.surface('platformRing', selected ? skin.selection.stroke : (g.borderColor ?? palette.platformStroke), { depthWrite: false }),
    )
    border.position.y = plat + 0.1
    unit.add(border)

    // bottom accent bar (2D renderGroupBottomBar: tags mode only — the deduped
    // tag colors of the group's members, along the platform's south edge)
    if (this.bottomTab === 'tags') {
      const members = this.data.objects.filter((o) => g.objectIds.includes(o.id))
      const colors = resolveGroupBottomBarColors(
        members,
        this.data.tags,
        skin,
        this.bottomTab,
        this.activeTagGroupId,
      )
      const bb = skin.bottomBar
      this.addAccentBar(unit, colors, {
        x: 0,
        w: r.w,
        zTop: r.h - bb.height,
        y: plat + 0.15,
        h: bb.height,
        r: this.pxr(14),
        opacity: bb.opacity,
      })
    }

    // mono uppercase label riding the board just above the plate (kit style),
    // with the group's technology icon on its left when one is set (2D header)
    const groupIconTex = g.icon
      ? techIconTexture(g, () => this.requestRender(), this.resolvedTheme)
      : null
    if (groupIconTex) {
      const iconMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(14, 14),
        new THREE.MeshBasicMaterial({ map: groupIconTex, transparent: true, depthWrite: false, toneMapped: false }),
      )
      iconMesh.userData.techIcon = g.icon // dev-probe marker
      iconMesh.rotation.x = -Math.PI / 2
      iconMesh.position.set(9, plat + 0.25, -12)
      unit.add(iconMesh)
    }
    const label = this.addText({
      text: g.name.toUpperCase(),
      font: 'mono600',
      size: 10,
      color: colorAlpha(skin.groups.label).color,
      letterSpacing: 0.16,
      anchorX: 'left',
      anchorY: 'bottom',
    })
    label.position.set(groupIconTex ? 20 : 2, plat + 0.2, -6)
    unit.add(label)

    this.groupPlates.set(g.id, unit)
    this.root.add(unit)
  }

  // ── cards (actor / system / app / component) ───────────────────────────────

  /** Lit cards read as FROSTED GLASS slabs: REAL transmission, not an alpha
   * fake — an opacity of ~0.82 still reads as opaque ceramic with the plinth
   * never ghosting through. Transmission renders the
   * scene behind the wall through the milky glass (the walnut plinth and the
   * board show through, refracted); depthWrite stays on for card-vs-card
   * occlusion. PERF NOTE: any visible transmissive material adds three's
   * whole-scene transmission pre-pass — the lit-perf e2e gate decides whether
   * this stays or falls back to a baked milky-gradient cheat. */
  private frostedWall(css: string): THREE.MeshPhysicalMaterial {
    const milky = new THREE.Color(mixColors(css, '#FFFFFF', 0.35))
    if (this.qualityTier !== 'high') {
      // medium/low (incl. the SwiftShader CI heuristic): the transmission
      // pre-pass re-renders the whole scene (3240 calls vs the 1900 budget
      // at 200 nodes), and even an alpha cheat's 200 transparent walls hug
      // the 45 ms frame budget with overdraw — so this tier keeps a fully
      // OPAQUE milky wall (the ghosting only reads on 'high' anyway).
      // setQualityTier rebuilds across the 'high' boundary so materials
      // always match the tier.
      return new THREE.MeshPhysicalMaterial({
        color: milky,
        roughness: 0.42,
        metalness: 0,
        clearcoat: 0.5,
        clearcoatRoughness: 0.25,
        envMapIntensity: 0.7,
      })
    }
    return new THREE.MeshPhysicalMaterial({
      color: milky,
      transmission: 0.75,
      thickness: 8,
      ior: 1.45,
      attenuationColor: new THREE.Color('#F3E4CB'),
      attenuationDistance: 90,
      roughness: 0.45,
      metalness: 0,
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
      envMapIntensity: 0.55,
    })
  }

  private buildCard(o: C4Object, baseY: number, presetDepth: number): THREE.Group {
    const skin = this.skin!
    const palette = this.palette!
    const objSkin = skin.objects[o.type]
    const selected = this.selectedIds.has(o.id)
    const external = o.scope === 'external'
    const w = o.size.width
    const h = o.size.height

    let cardBg = external ? objSkin.fillExternal : objSkin.fill
    // Theme node spec: sanitized overrides for this card.
    const spec = this.theme3d?.objectSpec({
      id: o.id,
      type: o.type,
      name: o.name,
      fill: cardBg,
      selected,
      external,
      zBase: baseY,
      zTop: baseY + presetDepth,
    }) ?? null
    cardBg = spec?.materials?.top ?? cardBg

    // pixel-snap themes read chunky: snapped depth, near-sharp corners
    const ps = this.theme3d?.pixelSnap ?? null
    let depth = presetDepth * (spec?.depthScale ?? 1) + (selected ? SELECTED_LIFT : 0)
    if (ps) depth = Math.max(ps * 2, Math.round(depth / ps) * ps)
    const radius = spec?.cornerRadius ?? (ps ? Math.min(3, ps) : CARD_RADIUS)

    const borderColor = selected ? objSkin.strokeSelected : objSkin.stroke
    const wallMix = this.env3d?.shading?.wallMix ?? 1
    const derived = nodeWallColors(palette, cardBg, selected, wallMix)
    const walls = {
      front: spec?.materials?.wallFront ?? derived.front,
      side: spec?.materials?.wallSide ?? derived.side,
    }

    const unit = new THREE.Group()
    unit.userData.topY = baseY + depth // anchor dots ride the lifted top face
    unit.userData.lodSize = w // projected-width proxy for decoration LOD
    if (spec?.bob) {
      this.motionUnits.push({
        obj: unit,
        bob: { ...spec.bob, phase: (o.id.charCodeAt(0) ?? 0) / 41 },
      })
    }

    // floor shadow (kit: inset 2, offset 10/12, opacity .55) — a rounded-rect
    // SDF matching the slab footprint, so it reads seated, not an oval blob
    const shadowSoft = 12
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 2 * shadowSoft, h + 2 * shadowSoft),
      this.shadowMaterial(w, h, radius + 1, palette.shadowColor, (selected ? 0.7 : 0.55) * (this.renderProfile === 'lit' ? 0.4 : 1), shadowSoft),
    )
    shadow.userData.shadowShape = 'roundedRect' // dev-probe marker
    shadow.rotation.x = -Math.PI / 2
    shadow.position.set(w / 2 + (selected ? 13 : 10), baseY + 0.3, h / 2 + (selected ? 16 : 12))
    unit.add(shadow)

    // theme custom body: a billboard/GLTF asset replaces the slab;
    // the name stays as a readable flat label riding the board in front
    if (spec?.geometry) {
      const assetTop = this.tryAssetBody(unit, o, spec, baseY)
      if (assetTop !== null) {
        unit.userData.topY = assetTop
        const label = this.addText({
          text: o.name,
          font: 'inter600',
          size: NAME_SIZE,
          color: colorAlpha(external ? objSkin.textExternal : objSkin.text).color,
          anchorX: 'center',
        })
        label.userData.lod = LOD_PRIMARY
        label.position.set(w / 2, baseY + 0.45, h + 10)
        unit.add(label)
        // asset bodies have no top face — the affordance rides the floor
        this.addExpandGlyph(unit, o, baseY + 0.45, {
          x: w - 26,
          z: 2,
          bg: mixColors(cardBg, objSkin.icon, 0.14),
          fg: objSkin.icon,
        })
        return unit
      }
    }

    // extruded slab: cap = border color (the top cap doubles as the 1px border
    // layer under the inset fill), sides = kit wall mix
    const capMat = this.surface('cardCap', borderColor)
    const cardLighting = this.renderProfile === 'lit' ? this.theme3d?.environment?.lighting : null
    const sideMat = cardLighting
      ? this.frostedWall(walls.front)
      : this.wallMaterial(
          walls.front,
          walls.side,
          ps ? { h: Math.max(ps * 2, Math.round((depth * 0.25) / ps) * ps), depth } : undefined,
        )
    const body = this.slab(w, h, radius, depth, capMat, sideMat)
    body.position.y = baseY
    if (cardLighting) {
      body.castShadow = true
      body.receiveShadow = true
      body.userData.frosted = true // dev-probe marker (ref1 glass anatomy)
    }
    unit.add(body)

    if (cardLighting) {
      // walnut plinth under the glass: wider than
      // the slab so the dark base rims the card and shows through the
      // frosted walls. Height 2.6 (an ink head pointing at a card on a
      // group platform rises over it: Scene3D.inkHeadLift).
      const plinthMat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#4E3A28'),
        roughness: 0.5,
        metalness: 0,
        clearcoat: 0.25,
        clearcoatRoughness: 0.3,
        envMapIntensity: 0.5,
      })
      const plinth = this.slab(w + 14, h + 14, radius + 5, 2.6, plinthMat, plinthMat)
      plinth.position.set(-7, baseY, -7)
      plinth.castShadow = true
      plinth.receiveShadow = true
      plinth.userData.plinth = true // dev-probe marker
      // close-up garnish: at 200-node fit-all the +1 color and +1 depth draw
      // per card blew the lit perf gate — the LOD system culls it with the
      // other secondary dressing once the card projects under 140 css px
      plinth.userData.lod = LOD_SECONDARY
      unit.add(plinth)
    }

    const topY = baseY + depth
    const borderW = selected ? 2 : 1
    const fillMat = this.surface('cardFill', cardBg)
    const fillPlate = this.plate(w - 2 * borderW, h - 2 * borderW, Math.max(this.pxr(1), radius - borderW), fillMat)
    fillPlate.position.set(borderW, topY + 0.15, borderW)
    fillPlate.userData.pick = { kind: 'object', id: o.id } satisfies PickTarget
    if (this.renderProfile === 'lit') fillPlate.receiveShadow = true
    unit.add(fillPlate)
    this.pickables.push(fillPlate)

    // theme card opacity (clamped ≥ 0.35 by the sanitizer)
    const specOpacity = spec?.materials?.opacity
    if (specOpacity !== undefined && specOpacity < 1) {
      for (const m of [capMat, fillMat]) {
        m.transparent = true
        m.opacity = specOpacity
      }
      if (sideMat instanceof THREE.ShaderMaterial) {
        ;(sideMat.uniforms.uOpacity as THREE.IUniform<number>).value = specOpacity
      } else {
        sideMat.opacity = specOpacity
      }
      sideMat.transparent = true
    }

    // theme edge glow: a thin bright rim riding the top face (neon signature)
    if (spec?.edgeGlow) {
      const gw = spec.edgeGlow.width ?? 1.5
      const glow = this.ringPlate(w + 2, h + 2, radius + 1, gw, this.surface('glow', spec.edgeGlow.color, { depthWrite: false }))
      glow.position.set(-1, topY + 0.22, -1)
      glow.userData.edgeGlow = true // dev-probe marker
      unit.add(glow)
    }

    // selection ring (kit: 4px accent @15% around the card)
    if (selected) {
      const ringCss = withAlpha(objSkin.strokeSelected, 0.15)
      const ring = this.ringPlate(w + 8, h + 8, this.pxr(radius + 4), 4, this.surface('selectionRing', ringCss, { depthWrite: false }))
      ring.position.set(-4, topY + 0.1, -4)
      unit.add(ring)
    }

    const z = topY + 0.3 // content layer

    // type tile + glyph — a set obj.icon swaps the type glyph for the
    // technology icon (image or generated badge), the 2D engine's rule
    const sub = objectShortDescription(o) ?? ''
    const textMaxW = w - 16
    const fittedDescription = fitObjectDescription({
      text: sub,
      maxWidth: textMaxW,
      measureText: approxTextWidth,
      maxHeight: Math.max(0, h - 54 - 20 - DESCRIPTION_TO_TYPE_BADGE_GAP),
    })
    const descriptionLines = fittedDescription.lines.length
    const contentTop = centeredObjectContentTop({
      height: h,
      descriptionLines,
      hasBadge: true,
      titleSize: NAME_SIZE,
      descriptionSize: fittedDescription.fontSize,
    })
    const content = objectContentLayout({ x: 0, y: 0, width: w, height: h, contentTop })
    const typeColor = external ? objSkin.iconExternal : objSkin.icon
    const techTex = o.icon
      ? techIconTexture(o, () => this.requestRender(), this.resolvedTheme)
      : null
    // The 20-px icon tile is the base design at every framing (user decision
    // 2026-10-10: the grow/hide badge rule of pass "labels" is gone).
    unit.userData.hasTech = !!o.icon
    if (techTex) {
      const glyph = new THREE.Mesh(
        new THREE.PlaneGeometry(20, 20),
        new THREE.MeshBasicMaterial({ map: techTex, transparent: true, depthWrite: false, toneMapped: false }),
      )
      glyph.userData.techIcon = o.icon
      glyph.userData.cardContentRole = 'icon'
      glyph.userData.cardContentAnchor = { x: content.centerX, z: content.iconCenterY }
      glyph.userData.lod = LOD_PRIMARY
      glyph.rotation.x = -Math.PI / 2
      glyph.position.set(content.centerX, z + 0.1, content.iconCenterY)
      unit.add(glyph)
    } else if (o.type === 'actor') {
      const actorTex = iconTexture('user', typeColor)
      if (actorTex) {
        const glyph = new THREE.Mesh(
          new THREE.PlaneGeometry(20, 20),
          new THREE.MeshBasicMaterial({ map: actorTex, transparent: true, depthWrite: false, toneMapped: false }),
        )
        glyph.userData.cardContentRole = 'icon'
        glyph.userData.cardContentAnchor = { x: content.centerX, z: content.iconCenterY }
        glyph.userData.lod = LOD_PRIMARY
        glyph.rotation.x = -Math.PI / 2
        glyph.position.set(content.centerX, z + 0.1, content.iconCenterY)
        unit.add(glyph)
      }
    } else {
      const iconCircle = this.plate(20, 20, this.pxr(10), this.surface('chrome', typeColor, { depthWrite: false }))
      iconCircle.userData.cardContentRole = 'icon'
      iconCircle.userData.cardContentAnchor = { x: content.centerX, z: content.iconCenterY }
      iconCircle.userData.lod = LOD_PRIMARY
      iconCircle.position.set(content.centerX - 10, z, content.iconCenterY - 10)
      unit.add(iconCircle)
      const iconLetters: Record<string, string> = { system: 'S', app: 'A', component: 'C' }
      const iconLetter = this.addText({
        text: iconLetters[o.type] ?? '?',
        font: 'inter600',
        size: 10,
        color: colorAlpha(skin.connections.labelBg).color,
        anchorX: 'center',
        anchorY: 'middle',
      })
      iconLetter.userData.cardContentRole = 'iconLetter'
      iconLetter.userData.cardContentAnchor = { x: content.centerX, z: content.iconCenterY }
      iconLetter.userData.lod = LOD_PRIMARY
      iconLetter.position.set(content.centerX, z + 0.1, content.iconCenterY + 0.5)
      unit.add(iconLetter)
    }

    // name + sub (DS: name 13/650, sub 10.5 subtle; left of the tile)
    const name = this.addText({
      text: o.name,
      font: 'inter600',
      size: NAME_SIZE,
      color: colorAlpha(external ? objSkin.textExternal : objSkin.text).color,
      anchorX: 'center',
      clipRect: [-textMaxW / 2, -100, textMaxW / 2, 100],
    })
    name.userData.cardContentRole = 'title'
    name.userData.cardContentAnchor = { x: content.centerX, z: content.titleTopY }
    name.userData.lod = LOD_PRIMARY
    name.position.set(content.centerX, z, content.titleTopY)
    unit.add(name)

    if (sub) {
      // lit: the studio subtitle grey #9A958C is 2.98:1 on the #FFFFFF card
      // (WCAG formula, computed 2026-10-08) — floored at AAA
      // (LIT_SMALL_INK_CONTRAST) against the card fill; the AA floor still
      // read near-white on cream at 10.5 px (loop 4 r3 workbench-labels.png)
      const subCss = external ? objSkin.descriptionExternal : objSkin.description
      const subColor = this.renderProfile === 'lit'
        ? ensureContrast(subCss, colorAlpha(cardBg).color, LIT_SMALL_INK_CONTRAST)
        : subCss
      const subText = this.addText({
        text: fittedDescription.lines.join('\n'),
        font: 'inter400',
        size: fittedDescription.fontSize,
        color: colorAlpha(subColor).color,
        anchorX: 'center',
        maxWidth: textMaxW,
        lineHeight: 1.15,
        align: 'center',
      })
      subText.userData.cardContentRole = 'description'
      subText.userData.cardContentAnchor = { x: content.centerX, z: content.descriptionTopY }
      subText.userData.cardContentLineCount = fittedDescription.lines.length
      subText.userData.cardContentFontSize = fittedDescription.fontSize
      subText.userData.cardContentTruncated = fittedDescription.truncated
      subText.userData.lod = LOD_SECONDARY
      subText.position.set(content.centerX, z, content.descriptionTopY)
      unit.add(subText)
    }

    // Compact shape-type badge. Technology stays represented by the icon and
    // perspective bars; this identity line is stable and localized like 2D.
    const typeLabel = objectTypeBadgeLabel(o.type)
    const pillW = Math.min(w - CARD_PAD_X * 2, approxTextWidth(typeLabel, PILL_SIZE) + 14)
    const pillX = (w - pillW) / 2
    const pill = this.plate(pillW, PILL_H, this.pxr(PILL_RADIUS), this.surface('chrome', objSkin.badgeBg, { depthWrite: false }))
    pill.userData.cardContentRole = 'typeBadge'
    pill.userData.cardContentAnchor = { x: content.centerX, z: content.typeBadgeTopY }
    pill.userData.lod = LOD_SECONDARY
    pill.position.set(pillX, z, content.typeBadgeTopY)
    unit.add(pill)
    const pillText = this.addText({
      text: typeLabel,
      font: 'inter600',
      size: PILL_SIZE,
      // lit: floored on the pill it sits on (loop 4 r3: "the 'App' pill is
      // pale pink on cream" — #56524C on #F1EFEB is 6.9:1, the warm key
      // light lifts the pill further)
      color:
        this.renderProfile === 'lit'
          ? colorAlpha(ensureContrast(objSkin.badgeText, colorAlpha(objSkin.badgeBg).color, LIT_SMALL_INK_CONTRAST)).color
          : objSkin.badgeText,
      anchorX: 'center',
      anchorY: 'middle',
    })
    pillText.userData.cardContentRole = 'typeBadgeText'
    pillText.userData.cardContentAnchor = { x: content.centerX, z: content.typeBadgeTopY + PILL_H / 2 }
    pillText.userData.lod = LOD_SECONDARY
    pillText.position.set(content.centerX, z + 0.1, content.typeBadgeTopY + PILL_H / 2 + 0.5)
    unit.add(pillText)
    // lit connection labels keep off the chip and the title (a floated
    // 'notifies' plate printed over Rollup worker's 'App' chip — view3d
    // quality loop 2, round 2, city-wide.png)
    const titleW = Math.min(textMaxW, approxTextWidth(o.name, NAME_SIZE))
    this.cardTextRects.set(o.id, [
      { x: pillX, y: content.typeBadgeTopY, w: pillW, h: PILL_H },
      { x: content.centerX - titleW / 2, y: content.titleTopY, w: titleW, h: NAME_SIZE * 1.3 },
    ])

    // bottom accent bar — ONLY while a BottomBar "color by" tab is active, the
    // 2D engine's exact rule (no tab → no bar; deliberately no always-on tech
    // strip). Same shared color resolution (tags
    // segmented / first tech / status), same skin height + opacity.
    if (this.bottomTab) {
      const colors = resolveObjectBottomBarColors(
        o,
        this.data.tags,
        skin,
        this.bottomTab,
        this.activeTagGroupId,
      )
      const bb = skin.bottomBar
      this.addAccentBar(unit, colors, {
        x: borderW,
        w: w - 2 * borderW,
        zTop: h - bb.height - borderW,
        y: z,
        h: bb.height,
        r: Math.max(0, radius - borderW),
        opacity: bb.opacity,
      })
    }

    // expand-into-lower-level affordance, mirroring the type tile top-right
    this.addExpandGlyph(unit, o, z, {
      x: w - CARD_PAD_X - 26,
      z: CARD_PAD_Y + 2,
      bg: mixColors(cardBg, typeColor, 0.14),
      fg: typeColor,
    })

    return unit
  }

  /** Segmented bottom accent bar (2D renderObjectBottomBar's geometry): equal
   * splits across the width, outer bottom corners rounded, laid flat on the
   * card face. Used by cards and group platforms; stores band the drum. */
  private addAccentBar(
    unit: THREE.Group,
    colors: string[],
    box: { x: number; w: number; zTop: number; y: number; h: number; r: number; opacity: number },
  ): void {
    if (colors.length === 0) return
    const segW = box.w / colors.length
    for (let i = 0; i < colors.length; i++) {
      const first = i === 0
      const last = i === colors.length - 1
      const mat = this.surface('accentBar', colors[i], { depthWrite: false })
      if (box.opacity < 1) {
        mat.transparent = true
        mat.opacity *= box.opacity
      }
      const seg = this.plate(
        last ? box.w - segW * i : segW,
        box.h,
        { tl: 0, tr: 0, br: last ? box.r : 0, bl: first ? box.r : 0 },
        mat,
      )
      seg.position.set(box.x + i * segW, box.y, box.zTop)
      seg.userData.accentBar = colors[i]
      seg.userData.lod = LOD_SECONDARY
      unit.add(seg)
    }
  }

  /** Corner expand glyph — the 3D twin of the 2D tile's Expand button
   * (Model Viewer drill affordance; only objects the host listed in
   * `expandableIds` get one, so the editor never shows it). Pickable: a
   * single click drills via PickTarget 'expand'. LOD tier PRIMARY — it hides
   * with the name once the card is a bare slab (and an invisible glyph is
   * not clickable: pickClient skips invisible hits). */
  private addExpandGlyph(
    unit: THREE.Group,
    o: C4Object,
    y: number,
    at: { x: number; z: number; bg: string; fg: string },
  ): void {
    if (!this.expandableIds.has(o.id)) return
    const BTN = 26
    const plate = this.plate(BTN, BTN, this.pxr(8), this.surface('chrome', at.bg, { depthWrite: false }))
    plate.position.set(at.x, y, at.z)
    plate.userData.pick = { kind: 'expand', id: o.id } satisfies PickTarget
    plate.userData.lod = LOD_PRIMARY
    plate.userData.expandGlyph = true // dev-probe marker (e2e)
    unit.add(plate)
    this.pickables.push(plate)
    const tex = iconTexture('expand', at.fg)
    if (tex) {
      const icon = new THREE.Mesh(
        new THREE.PlaneGeometry(15, 15),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
      )
      icon.userData.lod = LOD_PRIMARY
      icon.rotation.x = -Math.PI / 2
      icon.position.set(at.x + BTN / 2, y + 0.1, at.z + BTN / 2)
      unit.add(icon)
    }
  }

  // ── standees (store → database drum) ───────────────────────────────────────

  private buildStandee(o: C4Object, baseY: number): THREE.Group {
    const skin = this.skin!
    const palette = this.palette!
    const objSkin = skin.objects.store
    const selected = this.selectedIds.has(o.id)
    const w = o.size.width
    const h = o.size.height
    const cx = w / 2
    const cz = h / 2
    const lift = selected ? SELECTED_LIFT * 0.5 : 0
    const techName = orderedTechnologyUsages(o.technologyUsages, o.technologyUsageOrder)[0]?.snapshot.name
    let drumTint = techColor(skin, techName) ?? objSkin.icon

    // Theme node spec for the standee: tint + spin/bob.
    const spec = this.theme3d?.objectSpec({
      id: o.id,
      type: o.type,
      name: o.name,
      fill: drumTint,
      selected,
      external: o.scope === 'external',
      zBase: baseY,
      zTop: baseY + DRUM_H,
    }) ?? null
    drumTint = spec?.materials?.top ?? drumTint

    const unit = new THREE.Group()
    unit.userData.topY = baseY + 0.6 // anchors sit on the pad, not the drum
    unit.userData.lodSize = w // projected-width proxy for decoration LOD
    if (spec?.bob || spec?.spin) {
      this.motionUnits.push({
        obj: unit,
        ...(spec.bob ? { bob: { ...spec.bob, phase: (o.id.charCodeAt(0) ?? 0) / 41 } } : {}),
        // spinObj is attached below once the drum mesh exists
      })
    }

    // pixel-snap themes: the drum reads as a chunky low-poly OCTAGON standee —
    // flat-shaded facets (voxel look), every disc/ring matching its 8 sides.
    // theta0 keeps a facet centered toward the decal side (+Z), and the circle
    // geometries share the vertex set (circle t = drum t − 90°, both mod 45°).
    const pixel = this.theme3d?.pixelSnap != null
    const radial = pixel ? 8 : 48
    const theta0 = pixel ? -Math.PI / 8 : 0

    // footprint pad + shadow
    const pad = new THREE.Mesh(new THREE.CircleGeometry(PAD_R, radial, theta0), this.surface('pad', palette.padFill, { depthWrite: false }))
    pad.rotation.x = -Math.PI / 2
    pad.position.set(cx, baseY + 0.2, cz)
    pad.userData.pick = { kind: 'object', id: o.id } satisfies PickTarget
    unit.add(pad)
    this.pickables.push(pad)
    const padRing = new THREE.Mesh(new THREE.RingGeometry(PAD_R - 1, PAD_R, radial, 1, theta0), this.surface('padRing', palette.padBorder, { depthWrite: false }))
    padRing.rotation.x = -Math.PI / 2
    padRing.position.set(cx, baseY + 0.25, cz)
    unit.add(padRing)
    if (this.renderProfile === 'lit') {
      // the drum's key-light shadow starts AT the drum: a pad that did not
      // receive cut the first 13 units of it (PAD_R − DRUM_R) out of every
      // drum's shadow, which then began past a lit cream ring — the critic's
      // "drop shadows far from their casters" (lamp pass 2026-10-10)
      pad.receiveShadow = true
      padRing.receiveShadow = true
    }

    const sh = colorAlpha(palette.shadowColor)
    // lit profile: the REAL key-light shadow carries the drum — the SDF blob
    // only hints contact, so it shrinks and recenters (at full size it reads
    // as an oversized offset coffee stain)
    const litSdf = this.renderProfile === 'lit'
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(PAD_R * (litSdf ? 1.7 : 2.2), PAD_R * (litSdf ? 1.7 : 2.2)),
      new THREE.MeshBasicMaterial({ color: sh.color, transparent: true, opacity: sh.alpha * (litSdf ? 0.3 : 0.75), alphaMap: blobTexture(), depthWrite: false, toneMapped: false }),
    )
    shadow.rotation.x = -Math.PI / 2
    shadow.position.set(cx + (litSdf ? 3 : 7), baseY + 0.15, cz + (litSdf ? 3 : 7))
    unit.add(shadow)

    // theme custom body: replaces the drum, keeps pad + shadow +
    // a readable flat name label riding the board in front
    if (spec?.geometry) {
      const assetTop = this.tryAssetBody(unit, o, spec, baseY + lift)
      if (assetTop !== null) {
        const label = this.addText({
          text: o.name,
          font: 'inter600',
          size: 12,
          color: colorAlpha(objSkin.text).color,
          anchorX: 'center',
        })
        label.position.set(cx, baseY + 0.45, h + 10)
        unit.add(label)
        // asset bodies have no drum/pad face — the affordance rides the floor
        this.addExpandGlyph(unit, o, baseY + 0.45, {
          x: w - 26,
          z: 2,
          bg: mixColors(skin.connections.labelBg, drumTint, 0.2),
          fg: objSkin.icon,
        })
        return unit
      }
    }

    // drum body — kit cos-law shading baked as vertex colors. Pixel-snap
    // themes get HARD facets instead: non-indexed triangles, each colored by
    // its facet's center angle (snapped to the 45° octagon steps), so the
    // shading posterizes into 8 flat faces rather than a smooth sweep.
    const drumContrast = this.env3d?.shading?.drumContrast ?? 1
    const drumGeo: THREE.BufferGeometry = pixel
      ? new THREE.CylinderGeometry(DRUM_R, DRUM_R, DRUM_H, radial, 1, true, theta0).toNonIndexed()
      : new THREE.CylinderGeometry(DRUM_R, DRUM_R, DRUM_H, radial, 1, true, theta0)
    const pos = drumGeo.getAttribute('position')
    const colors = new Float32Array(pos.count * 3)
    const c = new THREE.Color()
    if (pixel) {
      for (let i = 0; i < pos.count; i += 3) {
        const vx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3
        const vz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3
        const theta = Math.round(((Math.atan2(-vx, vz) * 180) / Math.PI) / 45) * 45
        c.setStyle(colorAlpha(drumFaceColor(palette, theta, drumContrast)).color)
        for (let k = i; k < i + 3; k++) {
          colors[k * 3] = c.r
          colors[k * 3 + 1] = c.g
          colors[k * 3 + 2] = c.b
        }
      }
    } else {
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i)
        const vz = pos.getZ(i)
        const theta = (Math.atan2(-vx, vz) * 180) / Math.PI
        c.setStyle(colorAlpha(drumFaceColor(palette, theta, drumContrast)).color)
        colors[i * 3] = c.r
        colors[i * 3 + 1] = c.g
        colors[i * 3 + 2] = c.b
      }
    }
    drumGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const drumLighting = this.renderProfile === 'lit' ? this.theme3d?.environment?.lighting : null
    const drum = drumLighting
      ? new THREE.Mesh(
          new THREE.CylinderGeometry(DRUM_R, DRUM_R, DRUM_H, 48, 1, true, theta0),
          litSurface('drum', mixColors(palette.standeeLight, palette.standeeDark, 0.35), {}, drumLighting),
        )
      : new THREE.Mesh(drumGeo, new THREE.MeshBasicMaterial({ vertexColors: true }))
    if (drumLighting) {
      drumGeo.dispose() // the baked-color geometry is unused under the lit profile
      drum.castShadow = true
      drum.receiveShadow = true
    }
    drum.position.set(cx, baseY + lift + DRUM_H / 2, cz)
    drum.userData.pick = { kind: 'object', id: o.id } satisfies PickTarget
    unit.add(drum)
    this.pickables.push(drum)
    if (spec?.spin) {
      // spin the drum in place — the baked shading sweeping reads as sheen
      const entry = this.motionUnits[this.motionUnits.length - 1]
      if (entry && entry.obj === unit) {
        entry.spinObj = drum
        entry.spinSpeed = spec.spin.speed
      }
    }

    // bottom accent band ("color by" tab): the 2D engine clips the accent
    // stripe to the cylinder base — here it's a segmented band hugging the
    // drum's foot, one arc per color.
    if (this.bottomTab) {
      const colors = resolveObjectBottomBarColors(
        o,
        this.data.tags,
        skin,
        this.bottomTab,
        this.activeTagGroupId,
      )
      const bb = skin.bottomBar
      const bandH = Math.max(bb.height, 4)
      for (let i = 0; i < colors.length; i++) {
        const mat = this.surface('drumBand', colors[i], { side: THREE.DoubleSide })
        if (bb.opacity < 1) {
          mat.transparent = true
          mat.opacity *= bb.opacity
        }
        const arc = new THREE.Mesh(
          new THREE.CylinderGeometry(
            DRUM_R + 0.4,
            DRUM_R + 0.4,
            bandH,
            pixel ? Math.max(1, Math.ceil(radial / colors.length)) : 48,
            1,
            true,
            theta0 + (i / colors.length) * Math.PI * 2,
            (1 / colors.length) * Math.PI * 2,
          ),
          mat,
        )
        arc.position.set(cx, baseY + lift + bandH / 2 + 0.1, cz)
        arc.userData.accentBar = colors[i]
        unit.add(arc)
      }
    }

    // lid: tech-tinted disc + border ring (kit: mix(cyl 26%, surface)).
    // Lit profile: the 26% tech tint + flat ink ring reads as a cool decal
    // pasted on the porcelain — cap the tint on a warm
    // base and replace the ring with a real ceramic lip the light can catch.
    const surface = skin.connections.labelBg
    const lit = this.renderProfile === 'lit'
    const lidCss = lit ? mixColors('#EFE7D8', drumTint, 0.1) : mixColors(surface, drumTint, 0.26)
    const lid = new THREE.Mesh(new THREE.CircleGeometry(DRUM_R + 1, radial, theta0), this.surface('drumLid', lidCss))
    lid.rotation.x = -Math.PI / 2
    lid.position.set(cx, baseY + lift + DRUM_H + 0.2, cz)
    unit.add(lid)
    if (lit) {
      const lip = new THREE.Mesh(
        new THREE.TorusGeometry(DRUM_R + 0.4, 1.1, 8, 40),
        this.surface('drum', mixColors('#EFE7D8', drumTint, 0.12)),
      )
      lip.rotation.x = Math.PI / 2
      lip.position.set(cx, baseY + lift + DRUM_H + 0.2, cz)
      lip.castShadow = true
      unit.add(lip)
    } else {
      const lidRing = new THREE.Mesh(
        new THREE.RingGeometry(DRUM_R - 0.5, DRUM_R + 1, radial, 1, theta0),
        this.surface('padRing', mixColors(palette.padBorder, drumTint, 0.45), { depthWrite: false }),
      )
      lidRing.rotation.x = -Math.PI / 2
      lidRing.position.set(cx, baseY + lift + DRUM_H + 0.3, cz)
      unit.add(lidRing)
    }

    // tech badge decal standing on the drum's front face (kit TechIconBadge).
    // obj.icon → the technology icon (image or generated badge); otherwise
    // the tinted first-letter plate. The base design (edfc9c6f7), restored
    // on the user's decision of 2026-10-10: quality loop 4 had laid it on the
    // lid, grown it with the zoom and printed the name on the face instead.
    unit.userData.nodeKind = 'store'
    unit.userData.hasTech = !!o.icon || !!techName
    const drumIconTex = o.icon
      ? techIconTexture(o, () => this.requestRender(), this.resolvedTheme)
      : null
    if (drumIconTex) {
      // the raw logo, no plate — exactly how the 2D engine decals the store
      const badge = new THREE.Mesh(
        new THREE.PlaneGeometry(26, 26),
        new THREE.MeshBasicMaterial({ map: drumIconTex, transparent: true, toneMapped: false }),
      )
      badge.userData.techIcon = o.icon // dev-probe marker
      badge.userData.drumBadge = true // dev-probe marker (nodeFaces)
      badge.userData.lod = LOD_PRIMARY
      badge.position.set(cx, baseY + lift + DRUM_H / 2, cz + DRUM_R + 1.2)
      unit.add(badge)
    } else if (techName) {
      const badgeBg = drumTint
      const badge = new THREE.Group()
      const plateGeo = new THREE.PlaneGeometry(26, 26)
      const badgePlate = new THREE.Mesh(plateGeo, this.surface('chrome', badgeBg))
      badge.add(badgePlate)
      const letter = this.addText({
        text: (techName[0] ?? '?').toUpperCase(),
        font: 'inter600',
        size: 14,
        color: readableOn(badgeBg, '#1E1D1B', '#FFFFFF'),
        anchorX: 'center',
        anchorY: 'middle',
      })
      letter.rotation.x = Math.PI / 2 // undo the flat-on-board default: stand upright
      letter.position.z = 0.2
      badge.add(letter)
      badge.userData.drumBadge = true // dev-probe marker (nodeFaces)
      badge.userData.lod = LOD_PRIMARY
      badge.position.set(cx, baseY + lift + DRUM_H / 2, cz + DRUM_R + 1.2)
      unit.add(badge)
    }

    // name tag on the pad front (kit ed3c3__tag): the datastore NAME in
    // Inter 600 at SUB_SIZE, LOD_PRIMARY — the base design (edfc9c6f7). It
    // stands on the CAMERA side of the drum, clear of its pad (storeTagRect
    // has the measurement), its text held to the lit small-ink contrast floor
    // like the connection labels: the studio tag grey read faint on its plate
    // (tp2-final-dpr1/workbench-labels.png).
    const tagLabel = storeTagText(o)
    const tagRect = this.storeTagLocal.get(o.id) ?? storeTagRect(o, { x: 0, y: 0, w, h }, CAMERA_PRESETS[this.preset].rz, DRUM_R)
    if (tagRect) {
      const tagW = tagRect.w
      const tag = this.plate(tagW, STORE_TAG_H, this.pxr(7), this.surface('tagPlate', palette.tagBg))
      tag.userData.lod = LOD_PRIMARY
      tag.userData.storeTag = 'plate'
      tag.position.set(tagRect.x, baseY + 0.4, tagRect.y)
      unit.add(tag)
      const tagBorder = this.ringPlate(tagW, STORE_TAG_H, this.pxr(7), 1, this.surface('padRing', palette.padBorder, { depthWrite: false }))
      tagBorder.userData.lod = LOD_PRIMARY
      tagBorder.position.set(tagRect.x, baseY + 0.5, tagRect.y)
      unit.add(tagBorder)
      const tagInk =
        this.renderProfile === 'lit'
          ? ensureContrast(palette.tagText, colorAlpha(palette.tagBg).color, LIT_SMALL_INK_CONTRAST)
          : palette.tagText
      const tagText = this.addText({
        text: tagLabel,
        font: 'inter600',
        size: SUB_SIZE,
        color: colorAlpha(tagInk).color,
        anchorX: 'center',
        anchorY: 'middle',
      })
      tagText.userData.lod = LOD_PRIMARY
      tagText.userData.storeTag = 'text'
      tagText.position.set(tagRect.x + tagW / 2, baseY + 0.6, tagRect.y + STORE_TAG_H / 2 + 0.5)
      unit.add(tagText)
    }

    // selection ring around the pad
    if (selected) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(PAD_R + 2, PAD_R + 6, radial, 1, theta0),
        this.surface('selectionRing', withAlpha(objSkin.strokeSelected, 0.5), { depthWrite: false }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(cx, baseY + 0.35, cz)
      unit.add(ring)
    }

    // expand-into-lower-level affordance riding the pad's top-right corner
    this.addExpandGlyph(unit, o, baseY + 0.45, {
      x: cx + PAD_R * 0.62,
      z: cz - PAD_R * 0.62 - 26,
      bg: mixColors(surface, drumTint, 0.2),
      fg: objSkin.icon,
    })

    return unit
  }

  // ── connections (flat ribbons on the board) ────────────────────────────────

  /**
   * `labels`: 'inline' starts the lit-label placement pass inside this call
   * with room to finish a small board's (a full rebuild: the decor built
   * right after keeps off the placed plates); 'sliced' (default) leaves it
   * to short slices after the frame (runLabelJob).
   *
   * CONNECT FREEZE (user report "quand je connecte deux shapes … ça gèle",
   * 2026-10-11): on the dev landscape's 67-connection diagram 0ob3fum the
   * placement pass alone measured 1072 ms of a 1187 ms connection build
   * (connLabelPerf, connect-freeze probe, DPR 1), and this method runs on
   * every pointermove of a connection edit, twice on its pointerup (the
   * handler, then the store echo) and again on the write flush's echo —
   * pointerup was ONE 2378 ms task (LoAF: CANVAS.onpointerup). The pass
   * placed labels for a framing the user is not even looking at during a
   * gesture; it now runs between frames and input.
   */
  private buildConnections(labels: 'inline' | 'sliced' = 'sliced'): void {
    // inside batch(): the closing full rebuild rebuilds connections too
    if (this.batchDepth > 0) {
      this.batchDirty = true
      return
    }
    const skin = this.skin
    if (!skin) return
    const connBuildT0 = performance.now()
    // a pending placement pass placed the labels this build disposes
    this.cancelLabelJob()
    // what each label shows now (the previous pass's result, or the one it
    // carried): kept on screen by a label whose own inputs did not change
    // until this build's pass commits — no flash of every label back to its
    // build spot, full text, on each pointermove of a drag
    const shownBefore = new Map<
      string,
      { sig: string; plate: THREE.Vector3; plateScale: THREE.Vector3; text: THREE.Vector3; textScale: THREE.Vector3; shown: LabelShow }
    >()
    for (const s of this.connLabelScalers) {
      shownBefore.set(s.connId, {
        sig: s.sig,
        plate: s.plate.position.clone(),
        plateScale: s.plate.scale.clone(),
        text: s.text.position.clone(),
        textScale: s.text.scale.clone(),
        shown: s.shown,
      })
    }
    // an abbreviated plate wears its own geometry: the whole label's is not
    // in the layer then, so the traverse below would not dispose it
    for (const s of this.connLabelScalers) if (s.plate.geometry !== s.fullGeo) s.fullGeo.dispose()
    // reset layer (troika texts dispose through their own API, not traverse)
    const connTextSet = new Set<THREE.Object3D>(this.connTexts)
    this.connLayer.traverse((obj) => {
      if (connTextSet.has(obj)) return
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      // RETIRED, not disposed (retiredMaterials): every line shares ONE
      // program, and disposing all of its materials here destroyed it, so
      // the frame after EVERY connection build — each pointermove of an
      // endpoint drag, each store echo — re-linked it (getProgramInfoLog
      // 19-23 ms self in the reconnect frames, connect-freeze profile on
      // 0ob3fum, 2026-10-11). The first material of each program is KEPT
      // instead (keepConnProgram).
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) if (!this.keepConnProgram(m)) this.retire(m)
    })
    // label texts are POOLED by what makeText was given: a label this build
    // draws with the same text, font, size and color takes its old Text back
    // (no new troika material, no re-layout). makeText was 57-75 ms of each
    // 67-label build on 0ob3fum (profiled, connect-freeze 2026-10-11); what
    // the build does not take back is disposed at its end.
    const textPool = new Map<string, Text[]>()
    for (const t of this.connTexts) {
      const key = t.userData.poolKey as string | undefined
      if (key === undefined) {
        t.dispose()
        continue
      }
      const bucket = textPool.get(key)
      if (bucket) bucket.push(t)
      else textPool.set(key, [t])
    }
    this.connTexts = []
    this.connLayer.clear()
    this.pickables = this.pickables.filter(
      (p) => !CONN_PICK_KINDS.has((p.userData.pick as PickTarget | undefined)?.kind as PickTarget['kind']),
    )
    this.connGeoms.clear()
    this.connLabelOffsets.clear()
    this.connLabelBoxes = []
    this.connLabelScalers = []
    this.connLabelGrowth = { kWant: 1, labels: [] }
    this.connLines.clear()
    this.arrowDebug = []
    this.flowUnits = [] // meshes were in connLayer — already disposed above
    this.editChrome = null // its meshes too
    this.selectHalo = null
    this.inkUniforms.uInkPhase.value = -1

    const rects = new Map<string, Rect>()
    for (const o of this.data.objects) rects.set(o.id, this.objectRect(o))
    for (const g of this.data.groups) rects.set(g.id, this.groupRect(g))
    const edit = this.connEdit
    // lit labels steer clear of cards and drums (and of each other — placed
    // labels are appended as they land); groups are NOT obstacles, labels
    // legitimately sit on a group platform. Everything carries its height:
    // connLabelPlacement tests a plate where it is SEEN at the lift it
    // floats at, and the text-bearing features are hard.
    const labelOccluders: Occluder[] = []
    // the preset's view direction (stable across orbit — connections are not
    // rebuilt per frame): labels prefer the camera side of their wire and
    // avoid what a node hides behind it and covers in front of it
    const presetPose = CAMERA_PRESETS[this.preset]
    const labelToward = {
      x: Math.sin((presetPose.rz * Math.PI) / 180),
      y: Math.cos((presetPose.rz * Math.PI) / 180),
    }
    const layerY = this.connLayer.position.y
    if (this.renderProfile === 'lit') {
      for (const o of this.data.objects) {
        const r = rects.get(o.id)!
        const unit = this.nodeGroups.get(o.id)
        const baseY = ((unit?.userData.baseY as number | undefined) ?? 0) - layerY
        if (o.type === 'store') {
          const cx = r.x + r.w / 2
          const cz = r.y + r.h / 2
          // the drum body, the flat pad ring, and the subtitle tag the
          // standee carries on its camera side (storeTagRect) — the tag is
          // text, so it is hard. The name printed on the drum rides the
          // drum's own box.
          labelOccluders.push({
            box: { x: cx - DRUM_R - 2, y: cz - DRUM_R - 2, w: 2 * DRUM_R + 4, h: 2 * DRUM_R + 4 },
            bottom: baseY,
            top: baseY + DRUM_H,
          })
          labelOccluders.push({
            box: { x: cx - PAD_R - 4, y: cz - PAD_R - 4, w: 2 * PAD_R + 8, h: 2 * PAD_R + 8 },
            bottom: baseY,
            top: baseY + 0.5,
          })
          const tag = this.storeTag(o, r)
          if (tag) {
            labelOccluders.push({
              box: { x: tag.x - 3, y: tag.y - 3, w: tag.w + 6, h: tag.h + 6 },
              bottom: baseY + 0.4,
              top: baseY + 0.6,
              hard: true,
            })
          }
        } else {
          const topY = ((unit?.userData.topY as number | undefined) ?? baseY + layerY + presetPose.depth) - layerY
          // the slab (the lit plinth rims it by 7 px, 2.6 tall)
          labelOccluders.push({ box: { x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 }, bottom: baseY, top: topY })
          labelOccluders.push({ box: { x: r.x - 7, y: r.y - 7, w: r.w + 14, h: r.h + 14 }, bottom: baseY, top: baseY + 2.6 })
          for (const t of this.cardTextRects.get(o.id) ?? []) {
            labelOccluders.push({
              box: { x: r.x + t.x - 3, y: r.y + t.y - 3, w: t.w + 6, h: t.h + 6 },
              bottom: topY,
              top: topY + 0.5,
              hard: true,
            })
          }
        }
      }
    }

    // 2D focus parity: ANY selection enters focus mode; a connection is
    // highlighted when it is selected itself or leaves a selected shape/group
    // (isConnectionHighlighted — object and group sources are both "fromId is
    // selected"). Highlighted → highlight stroke + focus animation; the rest
    // dim to 15%, exactly the flat engine's numbers (the lit ink: 42 %,
    // inkLine.INK_DIM_OPACITY has the measurement).
    const focusMode = this.selectedIds.size > 0
    const styleArmed = this.connAnimationsEnabled && this.highlightStyle !== 'none'
    const anim = resolveConnectionAnimation(skin)
    const objectById = new Map(this.data.objects.map((object) => [object.id, object]))
    const groupById = new Map(this.data.groups.map((group) => [group.id, group]))
    // lit: every connection is an ink line (inkLine.ts) — casing + core,
    // their render order assigned after the loop (highlighted last)
    const lit = this.renderProfile === 'lit'
    const inkSet = lit ? this.inkSet() : null
    const inks: { halo: THREE.Mesh | null; casing: THREE.Mesh | null; core: THREE.Mesh; highlighted: boolean }[] = []
    // the ONE selected connection wears the selection halo (2D isSelected)
    const singleSelected = this.singleSelectedConnId()
    // 'Point mobile' on a lit ink line is a bead painted in the core (no
    // mesh): never under reduced motion — the static selected look is whole
    const beadOn = styleArmed && this.highlightStyle === 'traveling-dot' && !this.rig.prefersReducedMotion()

    for (const conn of this.data.connections) {
      const fromObject = objectById.get(conn.fromId)
      const toObject = objectById.get(conn.toId)
      const managed = this.activeManagedPerspective()
      const managedInteraction = managed ? this.managedPerspectiveInteractions[managed] : null
      const hiddenState = (object: C4Object | undefined) => object
        ? managed && managedInteraction
          ? resolveHiddenFacetState(object, managed, managedInteraction.hiddenIds, managedInteraction.hoveredId)
          : this.bottomTab === 'tags'
            ? resolveHiddenTagState(object, this.hiddenTagIds, this.hoveredTagId)
            : { hidden: false, temporarilyRevealed: false }
        : null
      const connectionHidden = managed && managedInteraction
        ? resolveHiddenFacetState(conn, managed, managedInteraction.hiddenIds, managedInteraction.hoveredId)
        : this.bottomTab === 'tags'
          ? resolveHiddenTagState(conn, this.hiddenTagIds, this.hoveredTagId)
          : { hidden: false, temporarilyRevealed: false }
      const fromHidden = hiddenState(fromObject)
      const toHidden = hiddenState(toObject)
      if (connectionHidden.hidden || fromHidden?.hidden || toHidden?.hidden) continue
      const focusedPerspectiveId = this.activeFocusedPerspectiveId()
      const connectionMatchesFocus = Boolean(
        focusedPerspectiveId
        && (managed
          ? facetValues(conn, managed).some((value) => value.id === focusedPerspectiveId)
          : conn.tagAssignments?.[focusedPerspectiveId]),
      )
      if (
        focusedPerspectiveId
        && this.tagFocusResolved
        && !connectionMatchesFocus
        && !this.tagFocusObjectIds.has(conn.fromId)
        && !this.tagFocusObjectIds.has(conn.toId)
      ) continue
      const fromRect = rects.get(conn.fromId)
      const toRect = rects.get(conn.toId)
      if (!fromRect || !toRect) continue
      const isLower = conn.kind === 'lower'
      const highlighted = this.selectedIds.has(conn.id) || this.selectedIds.has(conn.fromId)
      const perspectiveTag = this.bottomTab === 'tags'
        ? resolveConnectionPerspectiveTag(
          fromObject ?? groupById.get(conn.fromId),
          toObject ?? groupById.get(conn.toId),
          this.data.tags,
          this.activeTagGroupId,
          {
            hoveredTagId: this.hoveredTagId,
            focusedTagId: this.focusedTagId,
            pinnedTagIds: this.pinnedTagIds,
          },
          conn,
        )
        : null
      const perspectiveFacet = managed && managedInteraction
        ? resolveConnectionPerspectiveFacet(fromObject, toObject, managed, managedInteraction, conn)
        : null
      const perspectiveColor = perspectiveTag
        ? resolveTagColor(perspectiveTag.tagId, this.data.tags, skin)
        : perspectiveFacet && managed === 'technology'
          ? resolveTechnologyColor(perspectiveFacet.label, skin)
          : perspectiveFacet && managed === 'status'
            ? resolveStatusColor(perspectiveFacet.id as C4Object['status'], skin)
            : perspectiveFacet && managed === 'teams'
              ? resolveTeamColor(perspectiveFacet.id)
              : null
      const strokeCss = highlighted
        ? skin.connections.highlight
        : perspectiveColor ?? (isLower ? skin.connections.lower : skin.connections.normal)
      const hiddenPreviewAlpha = connectionHidden.temporarilyRevealed
        || fromHidden?.temporarilyRevealed
        || toHidden?.temporarilyRevealed
        ? 0.4
        : 1
      const alpha = (focusMode && !highlighted ? 0.15 : 1) * hiddenPreviewAlpha
      /** Focus-dim a decal material (ribbon/arrow/label) — transparent pass,
       * over the (opaque, depth-written) floor slab, so layering stays sound. */
      const dim = <M extends THREE.Material & { opacity: number }>(mat: M): M => {
        if (alpha < 1) {
          mat.transparent = true
          mat.opacity *= alpha
        }
        return mat
      }

      // in-flight bend drag routes through the working copy (committed on pointerup)
      const effConn =
        edit?.mode === 'waypoint' && edit.connId === conn.id ? { ...conn, waypoints: edit.working } : conn
      // the 2D route, in both profiles (Clean's: it stops 4 px off the source
      // and 14 px short of the target, where the flat arrowhead's tip lands)
      const geom = connectionPath(effConn, fromRect, toRect)
      this.connGeoms.set(conn.id, geom)
      const pts = samplePath(geom, 24)
      const a = geom.arrowTip
      let width: number
      if (inkSet) {
        // LIT: Clean's flat ribbon and flat 2D arrowhead, inked for the
        // board (inkLine.ts has the measurement): casing + core, one mesh
        // each with the head merged in, plus an invisible pick strip
        const ink = inkStyle({
          set: inkSet,
          highlighted,
          lower: isLower,
          perspectiveCss: perspectiveColor,
          highlightCss: skin.connections.highlight,
          focusDimmed: focusMode && !highlighted,
          previewAlpha: hiddenPreviewAlpha,
          selected: conn.id === singleSelected,
        })
        width = ink.width
        const dash = conn.type === 'dashed' ? INK_DASHED : conn.type === 'dotted' ? INK_DOTTED : null
        // a drum is a circle in its rect: the line meets its pad circle at
        // both ends, the 2D route kept up to there (inkHeadOnDisc)
        const padOf = (o: C4Object | undefined, r: Rect): InkDisc | null =>
          o?.type === 'store' ? { x: r.x + r.w / 2, z: r.y + r.h / 2, r: PAD_R } : null
        const toDisc = padOf(toObject, toRect)
        const fromDisc = padOf(fromObject, fromRect)
        let head: InkHead = { x: a.x, z: a.y, angle: a.angle, y: this.inkHeadLift(conn.toId) }
        let route = fromDisc ? inkStartOnDisc(pts, fromDisc) : pts
        if (toDisc) ({ pts: route, head } = inkHeadOnDisc(route, head, toDisc))
        // the route as drawn: closed straight into its head (inkRouteToHead)
        const inkPts = inkRouteToHead(route, head)
        this.connLines.set(
          conn.id,
          inkPts.map((p) => ({ x: p.x, y: 0, z: p.y })),
        )
        const bead = highlighted && beadOn
        const made = this.addInkLine(conn.id, inkPts, head, ink, dash, bead)
        if (made) inks.push({ ...made, highlighted })
        this.arrowDebug.push({
          connId: conn.id,
          toId: conn.toId,
          kind: 'flat',
          head,
          length: INK_HEAD_LEN,
          halfW: INK_HEAD_HALF_W,
          target: toRect,
          dash,
          highlighted,
          alpha: ink.opacity,
          strokeCss,
          ink,
        })
        // focus animation on the highlighted (source/selected) connection:
        // 'Point mobile' is the bead the core paints (addInkLine) — its unit
        // only drives the shared phase; the other styles keep their port
        if (bead) this.addInkBead(conn.id, geom, inkPts, made?.beadKs ?? [])
        else if (highlighted && styleArmed && this.highlightStyle !== 'traveling-dot')
          this.buildFlowEffect(geom, pts, width, anim, { coreCss: ink.core, rimCss: INK_SETS[inkSet].rim })
      } else {
        width = highlighted
          ? Math.max(2.6, skin.connections.strokeWidthHighlight * 1.2)
          : Math.max(2.2, skin.connections.strokeWidth * 1.2)
        this.connLines.set(
          conn.id,
          pts.map((p) => ({ x: p.x, y: 0, z: p.y })),
        )
        const dash: [number, number] | null = conn.type === 'dashed' ? [5, 4] : conn.type === 'dotted' ? [2, 3] : null
        const body = buildRibbon(pts, width, dash)
        if (body) {
          // DoubleSide — the strip's winding follows the path direction, so a
          // single-sided material would cull (and un-pick) half the connections
          const mesh = new THREE.Mesh(body, dim(this.surface('ribbon', strokeCss, { depthWrite: false, side: THREE.DoubleSide })))
          mesh.userData.pick = { kind: 'connection', id: conn.id } satisfies PickTarget
          this.connLayer.add(mesh)
          this.pickables.push(mesh)
        }

        // focus animation on the highlighted (source/selected) connection
        if (highlighted && styleArmed) this.buildFlowEffect(geom, pts, width, anim)

        // arrowhead (engine: 14px, at the target edge point)
        const arrowGeo = new THREE.BufferGeometry()
        const ax = a.x
        const ay = a.y
        const cosA = Math.cos(a.angle)
        const sinA = Math.sin(a.angle)
        const bx = ax - 14 * cosA
        const by = ay - 14 * sinA
        const nx = -sinA * 5
        const ny = cosA * 5
        arrowGeo.setAttribute(
          'position',
          new THREE.BufferAttribute(new Float32Array([ax, 0, ay, bx + nx, 0, by + ny, bx - nx, 0, by - ny]), 3),
        )
        arrowGeo.setIndex([0, 2, 1])
        this.connLayer.add(
          new THREE.Mesh(arrowGeo, dim(this.surface('ribbon', strokeCss, { depthWrite: false, side: THREE.DoubleSide }))),
        )
        this.arrowDebug.push({
          connId: conn.id,
          toId: conn.toId,
          kind: 'flat',
          head: { x: ax, z: ay, angle: a.angle, y: 0 },
          length: 14,
          halfW: 5,
          target: toRect,
          dash: null,
          highlighted,
          alpha,
          strokeCss,
          ink: null,
        })
      }
      // the lit labels sit on a flat line (connLabelPlacement: a level
      // profile at the layer's height, the core's half width for "radius")
      const labelProfile: CableProfile | null = inkSet ? cableProfileFor(0, 0, 0, pathLength(pts)) : null
      const labelLineR = width / 2

      // label plate + SDF text (kit: h17 r5 plate, 10.5 muted text). Offset is
      // applied along the path normal — the 2D engine's label placement — and
      // the plate is pickable so grabbing it starts the label-slide gesture.
      if (conn.label) {
        const draggingLabel = edit?.mode === 'label' && edit.connId === conn.id
        const t = draggingLabel ? edit.t : (conn.labelPosition ?? 0.5)
        const rawOffset = draggingLabel ? edit.offset : (conn.labelOffset ?? 0)
        const offset = Math.max(-40, Math.min(40, rawOffset))
        const pt = pathPoint(geom, t)
        const tan = pathTangent(geom, t)
        // lit profile: a larger label (the flat kit's 10.5 px read ~6 css px
        // at the iso framing of a 9-node board — illegible at 1600x1000
        // DPR 1, view3d quality loop 2026-10-08) on a taller plate
        const labelSize = labelProfile ? CONN_LABEL_SIZE_LIT : SUB_SIZE
        const plateH = labelProfile ? CONN_LABEL_PLATE_H_LIT : 17
        const lw = approxTextWidth(conn.label, labelSize) + 14
        // lit profile: the label sits ON its line, clear of the cards, drums
        // and other labels (connLabelPlacement.ts has the measurement); flat
        // profile: on the line, the 2D rule
        let mid = { x: pt.x - tan.y * offset, y: pt.y + tan.x * offset }
        let labelLift = 0
        if (labelProfile) {
          const placed = litLabelPlacement({
            sample: (s) => ({ pt: pathPoint(geom, s), tan: pathTangent(geom, s) }),
            t,
            offset,
            plateW: lw,
            plateH,
            cableR: labelLineR,
            profile: labelProfile,
            occluders: labelOccluders,
            polarDeg: presetPose.rx,
            toward: labelToward,
            dragging: draggingLabel,
          })
          mid = { x: placed.x, y: placed.y }
          labelLift = placed.lift
          this.connLabelOffsets.set(conn.id, { t: placed.appliedT, offset: placed.appliedOffset })
          // later labels avoid this one too (it is text: hard), and so does
          // the decor
          labelOccluders.push({
            box: { x: mid.x - lw / 2 - 3, y: mid.y - plateH / 2 - 3, w: lw + 6, h: plateH + 6 },
            bottom: labelLift,
            top: labelLift + 0.6,
            hard: true,
          })
          this.connLabelBoxes.push({ x: mid.x - lw / 2, y: mid.y - plateH / 2, w: lw, h: plateH })
        }
        // OPAQUE plate (view3d quality loop 2, round 2: the 'App' chip and
        // the 'Event bus' tag printed through 'notifies' / 'consumes'). The
        // plate was opaque in color but drew in the OPAQUE pass without
        // writing depth (lit decals never do — litSurface: the half-res AO
        // reads depth-writing decals as geometry and draws ghost halos), so
        // whatever decal or text drew after it — the card chip, the troika
        // text in the transparent pass — printed on top. It now draws in the
        // transparent pass AFTER every card/tag decal and text (renderOrder),
        // at full opacity: depth-tested against the slabs and cables, so a
        // plate behind a card still hides, and nothing beneath shows through.
        // The flat profile keeps the 2D rule (the skin's plate, on the line).
        const plateMat = this.surface(
          'connLabel',
          labelProfile ? colorAlpha(skin.connections.labelBg).color : skin.connections.labelBg,
        )
        if (labelProfile) plateMat.transparent = true
        const plate = this.plate(lw, plateH, this.pxr(5), plateMat)
        dim(plate.material as THREE.MeshBasicMaterial)
        if (labelProfile) plate.renderOrder = CONN_LABEL_PLATE_ORDER
        plate.position.set(mid.x - lw / 2, labelLift + 0.4, mid.y - plateH / 2)
        plate.userData.pick = { kind: 'connLabel', id: conn.id } satisfies PickTarget
        this.connLayer.add(plate)
        this.pickables.push(plate)
        // lit: the studio skin's muted label grey #8C877F is 2.86:1 on its
        // #E7E6E2 plate (WCAG formula, computed 2026-10-08) — floored at
        // AAA (LIT_SMALL_INK_CONTRAST) against the plate it sits on: at AA
        // it read "light grey on cream" (loop 4 r3 workbench-labels.png)
        const labelCss = labelProfile
          ? ensureContrast(skin.connections.labelText, colorAlpha(skin.connections.labelBg).color, LIT_SMALL_INK_CONTRAST)
          : skin.connections.labelText
        const textSpec = {
          text: conn.label,
          font: labelProfile ? ('inter600' as const) : ('inter400' as const),
          size: labelSize,
          color: colorAlpha(labelCss).color,
          anchorX: 'center' as const,
          anchorY: 'middle' as const,
        }
        const poolKey = `${textSpec.text}|${textSpec.font}|${textSpec.size}|${textSpec.color}`
        let label = textPool.get(poolKey)?.pop()
        if (label) {
          // back to what makeText made (showConnLabel may have abbreviated
          // it, the scaler grown or hidden it)
          this.connTexts.push(label)
          if (String(label.text) !== textSpec.text) {
            label.text = textSpec.text
            label.sync(() => this.requestRender())
          }
          label.visible = true
          label.scale.setScalar(1)
          label.renderOrder = 0
        } else {
          label = this.addText(textSpec, this.connTexts)
          label.userData.poolKey = poolKey
        }
        label.fillOpacity = alpha
        if (labelProfile) label.renderOrder = CONN_LABEL_PLATE_ORDER + 1
        label.position.set(mid.x, labelLift + 0.55, mid.y)
        this.connLayer.add(label)
        // lit: the label may GROW at far framings (labelLegibility.ts) —
        // never while it is being dragged (the gesture reads its plate)
        if (labelProfile && !draggingLabel) {
          // it grows about its wire point (connLabelPlacement.wireAnchor):
          // the wire stays under the plate at every scale
          const at = this.connLabelOffsets.get(conn.id)?.t ?? t
          const anchor = wireAnchor(mid, lw, plateH, pathPoint(geom, at))
          const applied = this.connLabelOffsets.get(conn.id)
          const profile = labelProfile
          const sample = (s: number) => ({ pt: pathPoint(geom, s), tan: pathTangent(geom, s) })
          const sig = `${this.preset}|${labelLift}|${conn.label}|${t}|${offset}|${labelLineR}|${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(';')}`
          this.connLabelScalers.push({
            plate,
            text: label,
            cx: mid.x,
            cz: mid.y,
            w: lw,
            h: plateH,
            anchor,
            kFree: 1,
            k: 1,
            connId: conn.id,
            boxIndex: this.connLabelBoxes.length - 1,
            t: applied?.t ?? t,
            offset: applied?.offset ?? offset,
            tPref: t,
            side: offset !== 0 ? Math.sign(offset) : cameraSide(pathTangent(geom, t), labelToward),
            sample,
            placeAt: (s, off) => {
              const p = litLabelPlacement({
                sample,
                t: s,
                offset: off,
                plateW: lw,
                plateH,
                cableR: labelLineR,
                profile,
                dragging: true,
              })
              return { x: p.x, y: p.y, lift: p.lift, t: p.appliedT, offset: p.appliedOffset }
            },
            cableR: labelLineR,
            fullText: conn.label,
            shown: { state: 'full', text: conn.label },
            fullGeo: plate.geometry,
            plateR: this.pxr(5),
            spots: [],
            lift: labelLift,
            sig,
          })
          const before = shownBefore.get(conn.id)
          if (before && before.sig === sig) {
            const s = this.connLabelScalers[this.connLabelScalers.length - 1]
            plate.position.copy(before.plate)
            plate.scale.copy(before.plateScale)
            label.position.copy(before.text)
            label.scale.copy(before.textScale)
            this.showConnLabel(s, before.shown)
          }
        }
      }
    }

    // the ink lines' draw order: per connection its casing, then its core,
    // in loop order with the highlighted ones last (on top)
    if (inks.length > 0) {
      const ordered = [...inks.filter((k) => !k.highlighted), ...inks.filter((k) => k.highlighted)]
      const step = INK_ORDER_SPAN / (2 * ordered.length)
      ordered.forEach((k, i) => {
        // the selection halo under its rim (above the previous line's core)
        if (k.halo) k.halo.renderOrder = Math.max(0.25, INK_ORDER_BASE + (2 * i - 0.5) * step)
        if (k.casing) k.casing.renderOrder = INK_ORDER_BASE + 2 * i * step
        k.core.renderOrder = INK_ORDER_BASE + (2 * i + 1) * step
      })
    }

    // label texts this build did not take back
    for (const bucket of textPool.values()) for (const t of bucket) t.dispose()

    if (this.connLabelScalers.length > 0) {
      const job = this.connLabelLayout(rects, presetPose, labelToward)
      this.runLabelJob(job, labels === 'inline')
    }

    // edit chrome for the single selected connection (write mode only)
    const selectedConnId = this.singleSelectedConnId()
    if (!this.readonly_ && selectedConnId) this.buildConnEditHandles(selectedConnId, rects)
    // lit: what the layer draws over the lines (the flow effect, the edit
    // chrome — default order 0, which the ink lines' 1-21 would paint over)
    if (inks.length > 0) this.liftOverInk(this.connLayer)
    const connBuildMs = performance.now() - connBuildT0
    this.connLabelPerf.connBuildMs = connBuildMs
    this.connLabelPerf.connBuildMaxMs = Math.max(this.connLabelPerf.connBuildMaxMs, connBuildMs)
    this.connLabelPerf.connBuilds++
    // a full rebuild's own compile gate covers the layer
    if (labels === 'sliced') this.scheduleConnCompile()
    this.requestRender()
  }

  /** The ink set the lit lines wear: the one reading the higher contrast on
   * the BOARD's base colour (the tray's paint, else the theme's board) — a
   * honey-wood tray keeps the dark ink in the dark appearance too. */
  private inkSet(): InkSetId {
    const tray = this.trayStyle()
    const base = tray && tray !== 'paper-grid' ? TRAY_BASE_CSS[tray] : colorAlpha(this.palette!.floorBg).color
    return inkSetFor(base).id
  }

  /** Layer-local height of a flat head pointing at `toId`: the lit card's
   * plinth rims the slab 7 px out and 2.6 tall, and the 2D tip lands on the
   * slab's edge — inside that rim. A head the rim would cover (a card on a
   * group platform, its rim above the layer) rises just over it. */
  private inkHeadLift(toId: string): number {
    const o = this.data.objects.find((x) => x.id === toId)
    if (!o || o.type === 'store') return 0
    const baseY = (this.nodeGroups.get(toId)?.userData.baseY as number | undefined) ?? 0
    return Math.max(0, baseY + 2.6 + 0.3 - this.connLayer.position.y)
  }

  /** One lit connection's ink: its casing (when it has one) and its core,
   * each ONE mesh with the head merged in, and an invisible pick strip. The
   * material is the unlit 'connInk' role patched by inkLine.patchInkMaterial
   * — one program for every ink mesh, the per-line colour and opacity are
   * uniforms. Flat printed ink: no shadow cast or received. */
  private addInkLine(
    connId: string,
    pts: { x: number; y: number }[],
    head: InkHead,
    ink: InkStyle,
    dash: readonly [number, number] | null,
    bead = false,
  ): { halo: THREE.Mesh | null; casing: THREE.Mesh | null; core: THREE.Mesh; beadKs: THREE.IUniform<number>[] } | null {
    const shape = { pts, head, width: ink.width, minCss: ink.minCss, maxCss: ink.maxCss, headCap: ink.headCap, screen: ink.screen }
    const coreGeo = buildInkGeometry({ ...shape, casing: 0, casingMinCss: 0, dash, bead })
    if (!coreGeo) return null
    const material = (css: string, opacity: number) => this.inkMaterial(css, opacity)
    let casing: THREE.Mesh | null = null
    if (ink.casing && ink.casing.opacity > 0) {
      const g = buildInkGeometry({
        ...shape,
        casing: ink.casing.width,
        casingMinCss: ink.casing.minCss,
        casingMaxCss: ink.casing.maxCss,
        dash,
      })
      if (g) {
        casing = new THREE.Mesh(g, material(ink.casing.css, ink.casing.opacity))
        casing.userData.ink = 'casing'
        casing.name = 'ink-casing'
        this.connLayer.add(casing)
      }
    }
    // the selection halo: the rim's outline grown by a soft band (css),
    // undashed — a selected dashed line glows along its whole run
    let halo: THREE.Mesh | null = null
    if (ink.select && ink.select.opacity > 0) {
      const g = buildInkGeometry({
        ...shape,
        casing: ink.casing?.width ?? 0,
        casingMinCss: ink.casing?.minCss ?? 0,
        casingMaxCss: ink.casing?.maxCss ?? 0,
        soft: ink.select.widthCss,
        // the dark board's glow brightens round the bead (INK_PACKET.glintCss)
        bead: bead && this.inkSet() === 'lightInk',
        dash: null,
      })
      if (g) {
        const hm = material(ink.select.css, ink.select.opacity)
        halo = new THREE.Mesh(g, hm)
        halo.userData.ink = 'halo'
        halo.name = 'ink-select-halo'
        this.connLayer.add(halo)
        // hovering the head or the target knob brightens it (+20 %, §4.2)
        this.selectHalo = { mat: hm, base: ink.select.opacity }
        if (this.handleUniforms.uHoverId.value === 1) hm.opacity = ink.select.opacity * 1.2
      }
    }
    const core = new THREE.Mesh(coreGeo, material(ink.core, ink.opacity))
    core.userData.ink = 'core'
    core.userData.connId = connId
    core.name = 'ink-core'
    this.connLayer.add(core)
    // the bead's fade, set per frame on every mesh that paints it
    const beadKs = bead ? [core, halo].filter((m): m is THREE.Mesh => !!m).map((m) => inkBeadUniform(m.material as THREE.Material)) : []
    return { halo, casing, core, beadKs }
  }

  /** The unlit 'connInk' role patched by inkLine.patchInkMaterial: ONE
   * program for every ink mesh (lines, halos, the drag preview), colour and
   * opacity per material. */
  private inkMaterial(css: string, opacity: number): THREE.MeshBasicMaterial {
    const m = this.surface('connInk', css) as THREE.MeshBasicMaterial
    m.transparent = true
    m.opacity = opacity
    m.depthWrite = false
    m.depthTest = true
    m.side = THREE.DoubleSide
    m.polygonOffset = true
    m.polygonOffsetFactor = -2
    m.polygonOffsetUnits = -2
    patchInkMaterial(m, this.inkUniforms)
    return m
  }

  /** 'Point mobile' on a lit ink line: the bead its core paints
   * (INK_FRAGMENT_COLOR) runs on the shared phase uInkPhase — this unit
   * only advances it (2D timing: INK_PACKET.cycleMs) and reports where the
   * bead is, for the probe. Its fade (uInkBeadK on the meshes that paint it)
   * is set per frame from the screen (updateInkBeads). */
  private addInkBead(connId: string, geom: PathGeometry, inkPts: { x: number; y: number }[], beadKs: THREE.IUniform<number>[]): void {
    let total = 0
    for (let i = 1; i < inkPts.length; i++) total += Math.hypot(inkPts[i].x - inkPts[i - 1].x, inkPts[i].y - inkPts[i - 1].y)
    const unit: FlowUnit = { kind: 'traveling-dot', geom, tick: () => {}, bead: { connId, ks: beadKs, fade: 0, clearPx: 0 } }
    unit.tick = (now) => {
      const t = (now % INK_PACKET.cycleMs) / INK_PACKET.cycleMs
      unit.lastT = t
      this.inkUniforms.uInkPhase.value = t
      let left = t * total
      for (let i = 1; i < inkPts.length; i++) {
        const l = Math.hypot(inkPts[i].x - inkPts[i - 1].x, inkPts[i].y - inkPts[i - 1].y)
        if (l >= left || i === inkPts.length - 1) {
          const k = l > 0 ? Math.min(1, left / l) : 0
          unit.pos = { x: inkPts[i - 1].x + (inkPts[i].x - inkPts[i - 1].x) * k, z: inkPts[i - 1].y + (inkPts[i].y - inkPts[i - 1].y) * k }
          break
        }
        left -= l
      }
    }
    unit.tick(performance.now())
    this.flowUnits.push(unit)
    this.requestRender()
  }

  /**
   * The lit ink line under client point (x, y), picked in SCREEN space: the
   * nearest line whose projected centreline passes within INK_PICK_PX, or
   * whose head (as the shader draws it) holds the point. The ink meshes'
   * own positions are zero-width anchors (the shader pushes them out), so a
   * raycast cannot see them; and a fixed-width world pick strip (the design
   * spec's 10 world px) missed 4-css-px-off clicks on 9 of 10 lines at the
   * default framing, where a css px is >1 world px and the line is seen
   * slanted (sl-r1-lines report.json, pick: 5 of 60 hits). `distance`: from
   * the camera to the line's point, for the caller to weigh against what the
   * raycast met first (a card in front still wins).
   */
  private inkLineAt(clientX: number, clientY: number): { id: string; point: THREE.Vector3; distance: number } | null {
    if (this.renderProfile !== 'lit' || this.arrowDebug.length === 0 || !this.connLayer.visible) return null
    const rect = this.canvas.getBoundingClientRect()
    const cam = this.rig.camera
    cam.updateMatrixWorld()
    this.connLayer.updateWorldMatrix(true, false)
    const layerM = this.connLayer.matrixWorld
    const camPos = cam.getWorldPosition(new THREE.Vector3())
    const v = new THREE.Vector3()
    const toScreen = (p: { x: number; y: number; z: number }) => {
      v.set(p.x, p.y, p.z).applyMatrix4(layerM).project(cam)
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, front: v.z > -1 && v.z < 1 }
    }
    let best: { id: string; d: number; local: { x: number; y: number; z: number } } | null = null
    for (const a of this.arrowDebug) {
      if (!a.ink) continue
      const line = this.connLines.get(a.connId) ?? []
      let prev: ReturnType<typeof toScreen> | null = null
      for (let i = 0; i < line.length; i++) {
        const s = toScreen(line[i])
        if (prev && prev.front && s.front) {
          const dx = s.x - prev.x
          const dy = s.y - prev.y
          const l2 = dx * dx + dy * dy
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((clientX - prev.x) * dx + (clientY - prev.y) * dy) / l2)) : 0
          const d = Math.hypot(prev.x + dx * t - clientX, prev.y + dy * t - clientY)
          if (d <= INK_PICK_PX && (!best || d < best.d)) {
            const p0 = line[i - 1]
            const p1 = line[i]
            best = { id: a.connId, d, local: { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t, z: p0.z + (p1.z - p0.z) * t } }
          }
        }
        prev = s
      }
      // the head, as drawn
      const tri = this.inkHeadAt(a, cam, rect.height).tri
      const [p, q, r] = tri.map(toScreen)
      const side = (a1: { x: number; y: number }, b1: { x: number; y: number }) => (b1.x - a1.x) * (clientY - a1.y) - (b1.y - a1.y) * (clientX - a1.x)
      const s1 = side(p, q)
      const s2 = side(q, r)
      const s3 = side(r, p)
      if (p.front && ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) && (!best || best.d > 0)) {
        best = { id: a.connId, d: 0, local: { x: (tri[0].x + tri[1].x + tri[2].x) / 3, y: a.head.y, z: (tri[0].z + tri[1].z + tri[2].z) / 3 } }
      }
    }
    if (!best) return null
    const point = new THREE.Vector3(best.local.x, best.local.y, best.local.z).applyMatrix4(layerM)
    return { id: best.id, point, distance: point.distanceTo(camPos) }
  }

  /** Lift what `root` holds at the default order 0 over the ink lines
   * (flow effects, edit chrome — the label plates keep their own order). */
  private liftOverInk(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (o.userData.ink || o.renderOrder !== 0 || this.connTexts.includes(o as Text)) return
      o.renderOrder = INK_ORDER_OVER
    })
  }

  /** The shared ink uniforms for the frame about to render: the canvas
   * height (css px) the projected floors are measured in, and the world px
   * per css px at the orbit target (the dash rhythm's scale). */
  private updateInkUniforms(): void {
    const vp = this.rig.getViewport()
    const pose = this.rig.getPose()
    this.inkUniforms.uInkViewH.value = vp.height
    this.inkUniforms.uInkViewW.value = vp.width
    this.inkUniforms.uInkWppTarget.value = (2 * pose.distance * Math.tan((pose.fov * Math.PI) / 360)) / Math.max(1, vp.height)
  }

  /** How `cam` draws lit head `a` (the shader's math, inkLine's CPU
   * mirror): world px per css px at its tip, its floor scale and grazing
   * stretch, and its triangle (layer-local). Unlit heads: scale 1. */
  private inkHeadAt(
    a: (typeof this.arrowDebug)[number],
    cam: THREE.PerspectiveCamera,
    vpH: number,
  ): { wpp: number; s: number; along: number; across: number; tri: { x: number; y: number; z: number }[] } {
    this.connLayer.updateWorldMatrix(true, false)
    const layerM = this.connLayer.matrixWorld
    const view = cam.matrixWorldInverse
    const tipV = new THREE.Vector3(a.head.x, a.head.y, a.head.z).applyMatrix4(layerM).applyMatrix4(view)
    const wpp = (2 * Math.max(-tipV.z, 1e-3)) / (cam.projectionMatrix.elements[5] * Math.max(1, vpH))
    const cap = a.ink?.screen === true
    const proj = (x: number, z: number) => {
      const d = new THREE.Vector3(x, 0, z).transformDirection(layerM)
      const m = view.elements
      // the view matrix's linear part applied to d (unit), its xy part —
      // with the perspective term for the highlight (screenDir, the shader)
      const v = { x: m[0] * d.x + m[4] * d.y + m[8] * d.z, y: m[1] * d.x + m[5] * d.y + m[9] * d.z, z: m[2] * d.x + m[6] * d.y + m[10] * d.z }
      return cap ? screenDir(v, tipV) : { x: v.x, y: v.y }
    }
    const ax = Math.cos(a.head.angle)
    const az = Math.sin(a.head.angle)
    const ink = a.ink !== null
    const tV = proj(ax, az)
    const nV = proj(-az, ax)
    // the highlight's base, sheared square to its on-screen axis (headShear)
    const shear = cap ? headShear(tV, nV) : 0
    const nWv = { x: nV.x - shear * tV.x, y: nV.y - shear * tV.y }
    const fit = ink ? headFit(wpp, Math.hypot(tV.x, tV.y), stripFacing(tV, nV), a.ink?.headCap === true, Math.hypot(nWv.x, nWv.y)) : { s: 1, along: 1, across: 1 }
    const { s, along, across } = fit
    const tri = ink
      ? inkHeadTriangle(a.head, s, along, across, shear)
      : [
          { x: a.head.x, z: a.head.z },
          { x: a.head.x - ax * a.length - az * a.halfW, z: a.head.z - az * a.length + ax * a.halfW },
          { x: a.head.x - ax * a.length + az * a.halfW, z: a.head.z - az * a.length - ax * a.halfW },
        ]
    return { wpp, s, along, across, tri: tri.map((p) => ({ x: p.x, y: a.head.y, z: p.z })) }
  }

  /** Every lit head's triangle on screen as `cam` draws it — the label
   * passes keep every plate clear of them. */
  private inkHeadHulls(
    cam: THREE.PerspectiveCamera,
    vpH: number,
    screen: (p: { x: number; y: number; z: number }) => { x: number; y: number },
  ): { x: number; y: number }[][] {
    cam.updateMatrixWorld()
    const out: { x: number; y: number }[][] = []
    for (const a of this.arrowDebug) {
      if (!a.ink) continue
      out.push(convexHull(this.inkHeadAt(a, cam, vpH).tri.map(screen)))
    }
    return out
  }

  /** arrowheadInfo probe (quality pass "arrows"): every connection's flat
   * arrowhead and its line, measured through the live camera — the head's
   * projected size at the scale the shader gives it, the client-px points
   * the harness reads the screenshot at (inside the head, round it, and
   * along the line with a point 8 css px off either side), and what of it
   * the camera sees (a ray to each point meets no node and no label plate
   * first). */
  private arrowheadProbe(): Scene3dArrowhead[] {
    this.scene.updateMatrixWorld()
    const cam = this.rig.camera
    cam.updateMatrixWorld()
    const rect = this.canvas.getBoundingClientRect()
    const layerM = this.connLayer.matrixWorld
    const toWorld = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(layerM)
    const ndc = new THREE.Vector3()
    const project = (w: THREE.Vector3) => {
      ndc.copy(w).project(cam)
      return {
        x: rect.left + ((ndc.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - ndc.y) / 2) * rect.height,
        front: ndc.z > -1 && ndc.z < 1,
      }
    }
    const inCanvas = (p: { x: number; y: number; front: boolean }) =>
      p.front && p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom
    const r1 = (p: { x: number; y: number }) => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1) })
    // occluders: the node solids and the label plates (the ink meshes are
    // zero-width anchors to a raycaster; the pick strips are not drawn)
    const plates = this.connLabelScalers.filter((s) => s.plate.visible).map((s) => s.plate)
    const targets: THREE.Object3D[] = [...this.nodeGroups.values(), ...plates]
    const raycaster = new THREE.Raycaster()
    const camPos = cam.getWorldPosition(new THREE.Vector3())
    // a node's SOLID parts (depth-written: slab, plinth, drum, pad) and every
    // label plate — not the soft contact-shadow decals a node lays on the
    // board round it (transparent, no depth write)
    const plateSet = new Set<THREE.Object3D>(plates)
    const blocks = (o: THREE.Object3D): boolean => {
      for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) return false
      if (plateSet.has(o)) return true
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      return !!m && !Array.isArray(m) && m.depthWrite
    }
    const seen = (w: THREE.Vector3): boolean => {
      const toP = w.clone().sub(camPos)
      const d = toP.length()
      raycaster.set(camPos, toP.normalize())
      raycaster.far = d - 0.6
      return !raycaster.intersectObjects(targets, true).some((hit) => blocks(hit.object))
    }
    /** Is the surface at client point `p` the board: outside every node
     * solid's silhouette on screen (nodeSolids: card slab + plinth rim, drum,
     * drum tag — the label passes' own solids) and with no label plate on
     * the ray through it? (A raycast against the card units let points on
     * the walnut plinth through: sl-r1-arrows az0, 'Query API -> Log
     * store'.) */
    const solidHulls = this.nodeSolids().map((n) => convexHull(n.pts.map((q) => project(new THREE.Vector3(q.x, q.y, q.z)))))
    const inHull = (p: { x: number; y: number }, h: readonly { x: number; y: number }[]): boolean => {
      if (h.length < 3) return false
      let sign = 0
      for (let i = 0; i < h.length; i++) {
        const a0 = h[i]
        const b0 = h[(i + 1) % h.length]
        const cr = (b0.x - a0.x) * (p.y - a0.y) - (b0.y - a0.y) * (p.x - a0.x)
        if (Math.abs(cr) < 1e-9) continue
        if (sign === 0) sign = Math.sign(cr)
        else if (Math.sign(cr) !== sign) return false
      }
      return true
    }
    const ndcRay = new THREE.Vector2()
    const onBoard = (p: { x: number; y: number }): boolean => {
      if (solidHulls.some((h) => inHull(p, h))) return false
      ndcRay.set(((p.x - rect.left) / rect.width) * 2 - 1, -((p.y - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(ndcRay, cam)
      raycaster.far = Infinity
      return !raycaster.intersectObjects(plates, false).length
    }
    const vpH = rect.height
    // every line's centreline on screen: a sample is graded against the
    // board only away from ANOTHER line (a crossing, two runs side by side:
    // there the "surface round it" is the other line's ink)
    const screenLines = this.arrowDebug.map((a) => ({
      id: a.connId,
      pts: (this.connLines.get(a.connId) ?? []).map((p) => project(toWorld(p))),
    }))
    const otherInkNear = (p: { x: number; y: number }, self: string, px: number): boolean =>
      screenLines.some(({ id, pts }) => {
        if (id === self) return false
        for (let i = 1; i < pts.length; i++) {
          const a0 = pts[i - 1]
          const b0 = pts[i]
          const dx = b0.x - a0.x
          const dy = b0.y - a0.y
          const l2 = dx * dx + dy * dy
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a0.x) * dx + (p.y - a0.y) * dy) / l2)) : 0
          if (Math.hypot(a0.x + dx * t - p.x, a0.y + dy * t - p.y) <= px) return true
        }
        return false
      })
    const storeIds = new Set(this.data.objects.filter((o) => o.type === 'store').map((o) => o.id))
    const out: Scene3dArrowhead[] = []
    for (const a of this.arrowDebug) {
      const at = this.inkHeadAt(a, cam, vpH)
      const [tipL, wingA, wingB] = at.tri
      const baseL = { x: (wingA.x + wingB.x) / 2, y: a.head.y, z: (wingA.z + wingB.z) / 2 }
      const tipW = toWorld(tipL)
      const baseW = toWorld(baseL)
      const pt = project(tipW)
      const pb = project(baseW)
      const pa = project(toWorld(wingA))
      const pc = project(toWorld(wingB))
      const span = Math.max(Math.hypot(pt.x - pa.x, pt.y - pa.y), Math.hypot(pt.x - pc.x, pt.y - pc.y), Math.hypot(pa.x - pc.x, pa.y - pc.y))
      // inside the head: barycentric points away from its edges, most of
      // them in its back half (the point meets its target's wall)
      const bary = [
        [0.34, 0.33, 0.33],
        [0.5, 0.25, 0.25],
        [0.2, 0.4, 0.4],
        [0.15, 0.6, 0.25],
        [0.15, 0.25, 0.6],
        [0.25, 0.5, 0.25],
        [0.25, 0.25, 0.5],
        [0.1, 0.45, 0.45],
      ]
      const facePts = bary.map(([u, v, w]) => ({
        x: tipL.x * u + wingA.x * v + wingB.x * w,
        y: a.head.y,
        z: tipL.z * u + wingA.z * v + wingB.z * w,
      }))
      const faceSeen = facePts.map((p) => toWorld(p)).filter((w) => seen(w))
      const face = faceSeen.map(project).filter(inCanvas).map(r1)
      // round it: off each flank's middle and off the point, 8 css px past
      // the casing (never off the base: its own line runs there)
      const casingW = a.ink?.casing ? Math.max(a.ink.casing.width, a.ink.casing.minCss * at.wpp) : 0
      const gap = casingW + 8 * at.wpp
      const centroid = { x: (tipL.x + wingA.x + wingB.x) / 3, z: (tipL.z + wingA.z + wingB.z) / 3 }
      const outward = (p: { x: number; z: number }, q: { x: number; z: number }, f: number) => {
        const m = { x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f }
        let nx = -(q.z - p.z)
        let nz = q.x - p.x
        const l = Math.hypot(nx, nz) || 1
        nx /= l
        nz /= l
        if ((m.x - centroid.x) * nx + (m.z - centroid.z) * nz < 0) {
          nx = -nx
          nz = -nz
        }
        return { x: m.x + nx * gap, y: a.head.y, z: m.z + nz * gap }
      }
      const ringL = [0.45, 0.65, 0.85].flatMap((f) => [outward(tipL, wingA, f), outward(tipL, wingB, f)])
      // (the support a viewer sees there: the board, not a node behind it)
      const ring = ringL.map((p) => toWorld(p)).filter((w) => seen(w)).map(project).filter(inCanvas).filter(onBoard).map(r1)
      const hullPts = [pt, pa, pc].filter((p) => p.front)
      const hull = convexHull(hullPts)
      let area = 0
      for (let i = 0; i < hull.length; i++) {
        const p = hull[i]
        const q = hull[(i + 1) % hull.length]
        area += p.x * q.y - q.x * p.y
      }
      // the line: up to 24 samples (its ends aside), each with a point 8 css
      // px off either side, square to the line ON SCREEN
      const line = this.connLines.get(a.connId) ?? []
      const linePts: Scene3dArrowhead['line']['pts'] = []
      let lineSamples = 0
      if (line.length >= 4) {
        const n = Math.min(24, line.length - 2)
        for (let k = 0; k < n; k++) {
          const i = 1 + Math.round((k * (line.length - 3)) / Math.max(1, n - 1))
          const w = toWorld(line[i])
          const c = project(w)
          if (!inCanvas(c)) continue
          lineSamples++
          if (!seen(w)) continue
          const p0 = project(toWorld(line[i - 1]))
          const p1 = project(toWorld(line[i + 1]))
          let tx = p1.x - p0.x
          let ty = p1.y - p0.y
          const tl = Math.hypot(tx, ty) || 1
          tx /= tl
          ty /= tl
          // the core's projected width there (the shader's floor + grazing)
          const view = cam.matrixWorldInverse
          const tipV = w.clone().applyMatrix4(view)
          const wpp = (2 * Math.max(-tipV.z, 1e-3)) / (cam.projectionMatrix.elements[5] * Math.max(1, vpH))
          const q0 = toWorld(line[i - 1])
          const q1 = toWorld(line[i + 1])
          const dx = q1.x - q0.x
          const dz = q1.z - q0.z
          const dl = Math.hypot(dx, dz) || 1
          // (the view matrix is rigid: transformDirection's renormalising
          // changes nothing)
          const nW = new THREE.Vector3(-dz / dl, 0, dx / dl).transformDirection(view)
          const tW = new THREE.Vector3(dx / dl, 0, dz / dl).transformDirection(view)
          // the highlight measures on screen (screenDir, the shader)
          const f = a.ink?.screen ? stripFacing(screenDir(tW, tipV), screenDir(nW, tipV)) : stripFacing(tW, nW)
          const widthPx = a.ink ? stripCoreWidthPx(a.ink.width, a.ink.minCss, wpp, f, a.ink.maxCss) : 0
          // what an UNSELECTED ink core would draw right there (the
          // hierarchy gate: selected >= 1.33x it at the same spot)
          const fPlain = stripFacing(tW, nW)
          const plainWidthPx = a.ink ? stripCoreWidthPx(INK_CORE_W, INK_CORE_MIN_CSS, wpp, fPlain, INK_CORE_MAX_CSS) : 0
          const cs = a.ink?.casing
          const rimPx = cs ? stripCasingWidthPx(cs.width, cs.minCss, cs.maxCss, wpp, f) : 0
          const off = (d: number) => ({ x: c.x - ty * d, y: c.y + tx * d })
          const l = off(8)
          const rr = off(-8)
          // the board at 4 and 8 css px either side (no node solid, no
          // plate — the rim and the halo lie inside 4), no other line near,
          // and clear of its own head (its sides there are the head's ink)
          const board =
            Math.hypot(c.x - pt.x, c.y - pt.y) > span + 8 &&
            [l, rr, off(4), off(-4)].every(onBoard) &&
            !otherInkNear(c, a.connId, 10) &&
            !otherInkNear(l, a.connId, 4) &&
            !otherInkNear(rr, a.connId, 4)
          linePts.push({
            c: r1(c),
            l: r1(l),
            r: r1(rr),
            board,
            widthPx: +widthPx.toFixed(2),
            plainWidthPx: +plainWidthPx.toFixed(2),
            rimPx: +rimPx.toFixed(2),
            capK: +inkCapGrowth(wpp).toFixed(4),
            f: +f.toFixed(3),
          })
        }
      }
      // plan distance from the tip to the target's 3D silhouette (< 0:
      // inside it): a lit drum's pad circle (as buildStandee lays it: PAD_R
      // round the rect's centre — read from the model here, never from the
      // head placement it checks), else the rect (a card's slab)
      const t = a.target
      const dxIn = Math.max(t.x - a.head.x, 0, a.head.x - (t.x + t.w))
      const dzIn = Math.max(t.y - a.head.z, 0, a.head.z - (t.y + t.h))
      const drum = a.ink !== null && storeIds.has(a.toId)
      const discD = drum ? Math.hypot(a.head.x - (t.x + t.w / 2), a.head.z - (t.y + t.h / 2)) - PAD_R : null
      const outside = discD !== null ? Math.max(0, discD) : Math.hypot(dxIn, dzIn)
      const inside = discD !== null ? -discD : Math.min(a.head.x - t.x, t.x + t.w - a.head.x, a.head.z - t.y, t.y + t.h - a.head.z)
      // a dashed / dotted lit line: its centreline every 0.5 world px of arc
      // (the shader's aArc: the same polyline), 20 px clear of either end,
      // where the camera sees open board round it
      let dashInfo: Scene3dArrowhead['dash'] = null
      if (a.ink && a.dash && line.length >= 2) {
        const period = a.dash[0] + a.dash[1]
        const scale = Math.max(1, (INK_DASH_MIN_CSS * this.inkUniforms.uInkWppTarget.value) / period)
        const pts: { arc: number; x: number; y: number }[] = []
        let total = 0
        for (let i = 1; i < line.length; i++) total += Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z)
        let arc0 = 0
        for (let i = 1; i < line.length; i++) {
          const p0 = line[i - 1]
          const p1 = line[i]
          const len = Math.hypot(p1.x - p0.x, p1.z - p0.z)
          for (let s = Math.ceil(arc0 / 0.5) * 0.5; s < arc0 + len; s += 0.5) {
            if (s < 20 || s > total - 20) continue
            const k = len > 0 ? (s - arc0) / len : 0
            const w = toWorld({ x: p0.x + (p1.x - p0.x) * k, y: p0.y + (p1.y - p0.y) * k, z: p0.z + (p1.z - p0.z) * k })
            const c = project(w)
            if (!inCanvas(c) || !seen(w) || !onBoard(c) || otherInkNear(c, a.connId, 8)) continue
            pts.push({ arc: +s.toFixed(2), x: +c.x.toFixed(2), y: +c.y.toFixed(2) })
          }
          arc0 += len
        }
        dashInfo = { on: a.dash[0], period, scale: +scale.toFixed(4), pts }
      }
      out.push({
        connId: a.connId,
        toId: a.toId,
        kind: 'flat',
        ink: a.ink !== null,
        drawn: true,
        tip: { x: tipW.x, y: tipW.y, z: tipW.z },
        base: { x: baseW.x, y: baseW.y, z: baseW.z },
        lengthPx: Math.hypot(pt.x - pb.x, pt.y - pb.y),
        widthPx: Math.hypot(pa.x - pc.x, pa.y - pc.y),
        thicknessPx: (() => {
          const l = Math.hypot(pt.x - pb.x, pt.y - pb.y) || 1
          return Math.abs((pa.x - pc.x) * (pt.y - pb.y) - (pa.y - pc.y) * (pt.x - pb.x)) / l
        })(),
        screenTri: { tip: r1(pt), base: r1(pb), a: r1(pa), b: r1(pc) },
        sizePx: span,
        scale: at.s,
        capK: +inkCapGrowth(at.wpp).toFixed(4),
        onScreen: inCanvas(pt) && inCanvas(pb),
        visibleFraction: faceSeen.length / facePts.length,
        tipClear: outside > 0 ? outside : -Math.max(0, inside),
        dash: dashInfo,
        highlighted: a.highlighted,
        alpha: a.alpha,
        css: a.ink ? a.ink.core : a.strokeCss,
        strokeCss: a.strokeCss,
        casing: a.ink?.casing ? { kind: a.ink.casing.kind, css: a.ink.casing.css, opacity: a.ink.casing.opacity } : null,
        hull: { areaPx: +Math.abs(area / 2).toFixed(1), pts: hull.map(r1) },
        face,
        ring,
        line: { samples: lineSamples, seen: linePts.length, pts: linePts },
        selected: a.ink?.select != null,
        selectHalo: a.ink?.select ? { ...a.ink.select } : null,
      })
    }
    return out
  }

  /**
   * Hidden stand-ins, built with every FULL rebuild, for the connection-layer
   * materials only a SELECTION draws: the focus-dimmed variant of each
   * opaque material (dim(): transparent), the selected cable's flow effect
   * and its edit chrome as an endpoint drag shows it (dots, dashed preview,
   * anchor rings). The full rebuild's compile gate links their programs
   * (three's compile walks invisible objects, warmDraw draws them) — a
   * click on a cable then links nothing: it added three programs (the
   * dimmed cable's transparent physical variant and two basic ones) and
   * their first use was a 119-133 ms task (reconnect-select on the test
   * board, tp5-connect3d, DEV shader checks). They live in `root`, so
   * clearRoot retires them with the build they belong to.
   */
  private buildConnProgramWarmers(): void {
    const skin = this.skin
    const first = this.data.connections.find((c) => this.connGeoms.has(c.id))
    if (!skin || !first) return
    const warm = new THREE.Group()
    warm.name = 'conn-program-warmers'
    warm.visible = false
    warm.position.copy(this.connLayer.position)
    // 1) the dimmed variant of every opaque connection-layer material
    const seen = new Set<THREE.Material>()
    this.connLayer.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || this.connTexts.includes(o as Text)) return
      const m = mesh.material as THREE.Material
      if (!m || Array.isArray(m) || m.transparent || seen.has(m)) return
      seen.add(m)
      const c = m.clone()
      c.transparent = true
      c.opacity *= 0.15
      const w = new THREE.Mesh(mesh.geometry, c)
      // the geometry is the layer's, not the warmer's
      w.userData.sharedGeometry = true
      w.castShadow = mesh.castShadow
      w.receiveShadow = mesh.receiveShadow
      warm.add(w)
    })
    // 2) a selected connection's flow effect and edit chrome, built by the
    // code that draws them, into the hidden group
    const layer = this.connLayer
    const pickables = this.pickables.length
    const flowUnits = this.flowUnits
    const edit = this.connEdit
    const chrome = this.editChrome
    const pressId = this.handleUniforms.uPressId.value
    try {
      this.connLayer = warm
      this.flowUnits = []
      const geom = this.connGeoms.get(first.id)!
      if (this.connAnimationsEnabled && this.highlightStyle !== 'none') {
        const width = Math.max(2.6, skin.connections.strokeWidthHighlight * 1.2)
        this.buildFlowEffect(geom, samplePath(geom, 24), width, resolveConnectionAnimation(skin), null)
      }
      if (!this.readonly_) {
        const rects = new Map<string, Rect>()
        for (const o of this.data.objects) rects.set(o.id, this.objectRect(o))
        for (const g of this.data.groups) rects.set(g.id, this.groupRect(g))
        this.connEdit = { mode: 'endpoint', connId: first.id, end: 'target', preview: { x: geom.toEdge.x, y: geom.toEdge.y }, hoverShapeId: first.toId }
        this.buildConnEditHandles(first.id, rects)
      }
    } finally {
      this.connLayer = layer
      this.pickables.length = pickables
      this.flowUnits = flowUnits
      this.connEdit = edit
      this.editChrome = chrome
      this.handleUniforms.uPressId.value = pressId
    }
    this.root.add(warm)
  }

  /**
   * Keep `m` (never disposed while the scene lives) when it is the first
   * connection-layer material seen with its program: a program dies with
   * the last material using it, and a selection's programs (the
   * focus-dimmed cables' variant, the flow effect, the edit chrome) are
   * used by nothing else on the board — each deselect destroyed them and
   * each selection linked them again (65-133 ms first-use tasks on the test
   * board, reconnect-select, tp5-connect3d, DEV shader checks). One
   * material per program: a few dozen at most. True when kept.
   */
  private keepConnProgram(m: THREE.Material): boolean {
    const key = (this.renderer.properties.get(m) as { currentProgram?: { cacheKey?: string } }).currentProgram?.cacheKey
    if (!key || this.connProgramKeepers.has(key)) return false
    this.connProgramKeepers.set(key, m)
    return true
  }
  private connProgramKeepers = new Map<string, THREE.Material>()

  /** Drop a pending placement pass (a newer build replaces what it placed,
   * or the scene is going away). */
  private cancelLabelJob(): void {
    if (!this.labelJob) return
    this.labelJob = null
    this.labelHold = false
    this.labelSliceFn = null
    this.connLabelPerf.jobsCancelled++
  }

  /**
   * Run placement pass `gen` in slices of LABEL_SLICE_MS, one per frame
   * (postLabelSlice). `inline` (a full rebuild) runs a first slice of
   * LABEL_INLINE_MS inside this call — a small board's whole pass (25-29 ms
   * on the 9-node test board, me-tp4 labelPerf), so its decor still keeps
   * off the placed plates; a pass that outruns it (1008 ms on 0ob3fum, in a
   * quality-tier rebuild, profiled) finishes sliced and refreshes the decor
   * when it commits. Each step of the pass is a label, a relocation or a
   * candidate spot, so a slice overruns its budget by one step at most.
   */
  private runLabelJob(gen: Generator<void, void, void>, inline: boolean): void {
    const job = { gen, t0: performance.now(), cpuMs: 0, slices: 0, maxSliceMs: 0 }
    this.labelJob = job
    this.labelHold = true
    const step = (budget: number) => {
      if (this.labelJob !== job || this.disposed) return
      const s0 = performance.now()
      let done: boolean
      try {
        do done = job.gen.next().done === true
        while (!done && performance.now() - s0 < budget)
      } catch (err) {
        // never leave the labels frozen behind a pass that threw
        this.labelJob = null
        this.labelHold = false
        throw err
      }
      const ms = performance.now() - s0
      job.cpuMs += ms
      job.slices++
      job.maxSliceMs = Math.max(job.maxSliceMs, ms)
      if (!done) {
        this.postLabelSlice(() => step(LABEL_SLICE_MS))
        return
      }
      this.labelJob = null
      this.connLabelPerf.buildMs = job.cpuMs
      this.connLabelPerf.jobSlices = job.slices
      this.connLabelPerf.jobMaxSliceMs = job.maxSliceMs
      this.connLabelPerf.jobWallMs = performance.now() - job.t0
      // a full rebuild's pass done in its inline slice: the decor is built
      // right after it, around the placed plates, and the build renders
      if (inline && job.slices === 1) return
      // else the decor keeps off the PLACED plates: one built while the pass
      // was pending (a full rebuild whose pass outran its inline slice), or
      // around plates the pass has since moved, is refreshed
      if (this.decorBuild && labelBoxesSig(this.connLabelBoxes) !== this.decorAvoidSig) this.scheduleDecorRefresh()
      // the plates moved / re-scaled / re-texted: a camera frame (plates and
      // label text cast no shadow)
      this.requestCameraRender()
    }
    // a full rebuild starts its pass inside the build (its decor needs the
    // placed plates); any other build leaves the whole pass to the slices
    // after its frame — the task that rebuilt (a pointermove, the pointerup,
    // the store echo) pays the geometry only
    if (inline) step(LABEL_INLINE_MS)
    else this.postLabelSlice(() => step(LABEL_SLICE_MS))
  }

  /** Queue the next slice of the placement pass right AFTER the next frame
   * (a frame callback posts it as a task): one slice per frame. Slices
   * posted back to back starved the frames instead — 12-13 slices of 8 ms
   * ran between two frames, long animation frames of 117-150 ms (LoAF,
   * connect-freeze on 0ob3fum), and the frame-pacing governor read those as
   * slow frames and dropped the quality tier, whose full rebuild was a
   * 1530-ms task (profiled). A timer stands in for the frame callback in a
   * hidden tab (no frames there; the pass must still finish). Measured
   * after: headless Chrome still showed ~10 slices inside one long
   * animation frame on 0ob3fum (why it frames them so is not established),
   * each slice an 8-13 ms task — input runs between them (blockingMs 0 on
   * those frames). */
  private postLabelSlice(fn: () => void): void {
    if (!this.labelChannel) {
      const ch = new MessageChannel()
      ch.port1.onmessage = () => {
        const f = this.labelSliceFn
        this.labelSliceFn = null
        f?.()
      }
      this.labelChannel = ch
    }
    this.labelSliceFn = fn
    const ch = this.labelChannel
    let posted = false
    const post = () => {
      if (posted) return
      posted = true
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      ch.port2.postMessage(0)
    }
    const raf = requestAnimationFrame(post)
    const timer = setTimeout(post, 100)
  }

  /**
   * The lit-label placement pass (it was the tail of buildConnections): grow
   * room on the board, relocations along each wire, the pairwise settle, the
   * SCREEN pass at the default framing, then the commit — scale, spots, and
   * what each label shows. A generator: it yields between steps so
   * runLabelJob can slice it; the result is the same whether it runs inline
   * or sliced (nothing it reads changes between slices without a rebuild,
   * and a rebuild cancels it).
   */
  private *connLabelLayout(
    rects: Map<string, Rect>,
    presetPose: (typeof CAMERA_PRESETS)[CameraPresetId],
    labelToward: { x: number; y: number },
  ): Generator<void, void, void> {
    // how far each label may grow before it touches a card, a drum, a cable
    // it does not already float over, or another (growing) label
    {
      const obstacles: { x: number; y: number; w: number; h: number; strict?: boolean }[] = []
      // a TALL body also hides the board behind it, as seen from the preset
      // camera: its footprint is stretched away from the camera by
      // height x tan(polar) (loop3-r2-fix-e: 'reads' grew in behind the Log
      // store drum and was cut by it on screen)
      const behind = Math.tan((presetPose.rx * Math.PI) / 180)
      /** The footprint swept away from the camera by height x tan(polar),
       * as a chain of footprint copies — a diagonal band, not its bounding
       * box (one box over-claimed: 'searches' froze beside the Log store
       * drum in loop3-r2-fix-h with nothing on screen in its way). */
      const tall = (b: { x: number; y: number; w: number; h: number }, height: number) => {
        const dx = -labelToward.x * height * behind
        const dz = -labelToward.y * height * behind
        const steps = 6
        return Array.from({ length: steps + 1 }, (_, i) => ({ ...b, x: b.x + (dx * i) / steps, y: b.y + (dz * i) / steps }))
      }
      for (const o of this.data.objects) {
        const r = rects.get(o.id)!
        if (o.type === 'store') {
          const cx = r.x + r.w / 2
          const cz = r.y + r.h / 2
          const tag = this.storeTag(o, r)
          // NOT the drum's pad ring: it is a 0.5-tall disk flat on the board
          // — a plate floating over its rim hides nothing that reads, and as
          // a hard limit it froze 'searches' and 'reads' at k = 1 beside the
          // Log store (loop4-r1 legibility.labels: 5.8 / 6.0 px)
          // strict: a label already tucked partly behind it must not grow
          // further in (it would be cut by the drum on screen)
          for (const s of tall({ x: cx - DRUM_R, y: cz - DRUM_R, w: 2 * DRUM_R, h: 2 * DRUM_R }, DRUM_H)) obstacles.push({ ...s, strict: true })
          if (tag) obstacles.push(tag)
        } else obstacles.push(...tall({ x: r.x - 7, y: r.y - 7, w: r.w + 14, h: r.h + 14 }, presetPose.depth))
      }
      // the wires (the node zones above are board-plane stand-ins; the
      // screen pass below tests the nodes themselves)
      const wireObstacles: { x: number; y: number; w: number; h: number }[] = []
      const wireOwner: string[] = []
      for (const [connId, geom] of this.connGeoms) {
        for (const p of samplePath(geom, 12)) {
          wireObstacles.push({ x: p.x - 3, y: p.y - 3, w: 6, h: 6 })
          wireOwner.push(connId)
        }
      }
      const nodeObstacleCount = obstacles.length
      obstacles.push(...wireObstacles)
      // ONE index over the node zones and every wire sample for the whole
      // pass; each label's view of it drops what it may overlap
      // (labelLegibility.BoxGrid has the measurement)
      const grid = new BoxGrid(obstacles)
      const ownWire = (idx: number, own: string) => idx >= nodeObstacleCount && wireOwner[idx - nodeObstacleCount] === own
      /** Every obstacle label i must respect at its own size: the node zones
       * and every wire but its OWN — it sits on that one by construction
       * (connLabelPlacement: on the wire, always), and growing along it is
       * not a collision. */
      const obstacleCache = new Map<number, ObstacleSource>()
      const baseFor = (i: number): ObstacleSource => {
        let b = obstacleCache.get(i)
        if (!b) {
          const own = this.connLabelScalers[i].connId
          b = exceptSource(grid, (idx) => ownWire(idx, own))
          obstacleCache.set(i, b)
        }
        return b
      }
      /** …and the wires alone (every one but label i's own). */
      const otherWiresFor = (i: number): ObstacleSource => {
        const own = this.connLabelScalers[i].connId
        return exceptSource(grid, (idx) => idx < nodeObstacleCount || ownWire(idx, own))
      }
      const boxOf =(s: (typeof this.connLabelScalers)[number]) => ({ x: s.cx - s.w / 2, y: s.cz - s.h / 2, w: s.w, h: s.h })
      let boxes = this.connLabelScalers.map(boxOf)
      let anchors = this.connLabelScalers.map((s) => s.anchor)
      const free: number[] = []
      for (let i = 0; i < boxes.length; i++) {
        free.push(freeScale(boxes[i], baseFor(i), CONN_LABEL_MAX_GROW, anchors[i]))
        yield
      }
      // A label boxed in where the placement left it SLIDES along its own
      // wire to the stretch with room for the scale the default framing asks
      // of it (labelLegibility.roomiestSpot), most constrained first.
      const framing = this.defaultFramingPose()
      const kWant = legibleScale(this.connLabelCapPx(framing), CONN_LABEL_MAX_GROW)
      const moved = new Set<number>()
      /** Move label i to the roomiest spot along its wire, every other label
       * reserving `reserve[j]` of growth, when that buys real growth over
       * the `have` it has now. True when it moved. */
      type LabelSpot = {
        box: Box
        anchor: { x: number; y: number }
        at: { x: number; y: number; lift: number; t: number; offset: number }
      }
      /** Every obstacle label i's growth must respect: the cards, drums and
       * wires, and every OTHER label at the size it reserves (`reserve[j]`,
       * capped at kWant — never steal its room). */
      const labelsFor = (i: number, reserve: readonly number[]): Box[] => {
        const others: Box[] = []
        boxes.forEach((b, j) => {
          if (j !== i) others.push(scaleAbout(b, Math.max(1, Math.min(reserve[j], kWant)), anchors[j]))
        })
        return others
      }
      const othersFor = (i: number, reserve: readonly number[], base: ObstacleSource = baseFor(i)) =>
        unionSource(base, labelsFor(i, reserve))
      /** Label i's candidate spots in preference order: where it sits, then
       * the spots ON its wire nearest its preferred arc position
       * (connLabelPlacement.onWireSpots — the only candidates any stage
       * draws from). The old list reached clearance + 120 px off the wire
       * ('consumes' / 'searches' found room to grow out there, loop4) and is
       * what left 'notifies' / 'writes' floating ~150 css px from any wire
       * (tp2-final-dpr1/workbench-wide.png; connLabelWireInfo: 41-183
       * world px for all ten labels). A label boxed in on its wire is shrunk
       * by the screen pass below instead. */
      const spotsFor = (i: number): LabelSpot[] => {
        const s = this.connLabelScalers[i]
        const spots: LabelSpot[] = []
        const pushSpot = (at: ReturnType<typeof s.placeAt>) => {
          spots.push({
            box: { x: at.x - s.w / 2, y: at.y - s.h / 2, w: s.w, h: s.h },
            anchor: wireAnchor(at, s.w, s.h, s.sample(at.t).pt),
            at,
          })
        }
        pushSpot({ x: s.cx, y: s.cz, lift: s.lift, t: s.t, offset: s.offset })
        for (const w of onWireSpots(s.sample, s.tPref, s.h, s.side)) pushSpot(s.placeAt(w.t, w.offset))
        return spots
      }
      /** Put label i at `spot` (k = 1 until applyConnLabelScale), with
       * `room` as its free scale there. State only: the commit below puts
       * every plate where its state says. */
      const moveTo = (i: number, spot: LabelSpot, room: number) => {
        const s = this.connLabelScalers[i]
        const { at, anchor } = spot
        const dx = at.x - s.cx
        const dz = at.y - s.cz
        s.cx = at.x
        s.cz = at.y
        s.anchor = anchor
        s.t = at.t
        s.offset = at.offset
        s.lift = at.lift
        s.k = 1
        this.connLabelOffsets.set(s.connId, { t: at.t, offset: at.offset })
        const lb = this.connLabelBoxes[s.boxIndex]
        if (lb) {
          lb.x += dx
          lb.y += dz
        }
        boxes = this.connLabelScalers.map(boxOf)
        anchors = this.connLabelScalers.map((o) => o.anchor)
        free[i] = room
        moved.add(i)
      }
      const relocate = (i: number, reserve: readonly number[], have = reserve[i]): boolean => {
        const spots = spotsFor(i)
        const best = roomiestSpot(spots, othersFor(i, reserve), CONN_LABEL_MAX_GROW, kWant)
        // a move must buy real growth over what the label has now (its own
        // free room on the first pass, what the settle left it on the second)
        if (!best || best.index === 0 || best.k <= have + 0.05) return false
        moveTo(i, spots[best.index], best.k)
        return true
      }
      const byRoom = (ks: readonly number[]) =>
        ks.map((k, i) => ({ k, i })).filter((e) => e.k < kWant - 1e-9).sort((a, b) => a.k - b.k)
      for (const { i } of byRoom(free)) {
        relocate(i, free)
        yield
      }
      // the room with every label where it now sits, then the pairs settled
      const settle = function* (): Generator<void, number[], void> {
        for (let i = 0; i < boxes.length; i++) {
          free[i] = freeScale(boxes[i], baseFor(i), CONN_LABEL_MAX_GROW, anchors[i])
          yield
        }
        return settleScales(boxes, free, anchors)
      }
      let settled = yield* settle()
      // a second pass for the labels the pairwise settle shrank: they look
      // again with every neighbour reserving what it actually got
      // ('writes' was settled from x2 to x1.4 against 'notifies' stuck at x1.1)
      // …repeated while anything moves (a move frees the room it left:
      // 'notifies' had none until 'writes' left its spot), bounded
      // A label still boxed in may claim room a neighbour only RESERVED for
      // its growth (never its plate): the neighbour, shrunk by the settle,
      // looks again on the next pass. Without it the result hung on the
      // order connections arrive in — 'notifies' read 5.6 px on one run and
      // 10.5 on another with the same board (loop4 final, DPR 1 vs 2).
      const unreserved = this.connLabelScalers.map(() => 1)
      for (let pass = 0; pass < 3; pass++) {
        let again = false
        for (const { i } of byRoom(settled)) {
          again = relocate(i, settled) || relocate(i, unreserved, settled[i]) || again
          yield
        }
        if (!again) break
        settled = yield* settle()
      }
      // SCREEN TRUTH at the default framing (quality pass "labels",
      // tp-final-dpr1/workbench-wide.png: 'evaluates' tucked under Alert
      // manager, 'queries' jammed between Query API and Web console). Every
      // rule above reasons on the board plane with an orthographic stand-in
      // for the preset view, and growth ignores an obstacle a label already
      // touches at k = 1; measured through the real fit camera, 'queries'
      // overlapped both cards by 4-5 px and 'evaluates' Alert manager by
      // 0.4 px. Each plate is projected at the scale it wears there, against
      // each card's slab + plinth, each drum's body and the other plates;
      // one that touches first tries a smaller scale where it sits, then the
      // free stretch of its own wire nearest its preferred arc position that
      // is clear on screen and still reads (LABEL_SCREEN_MIN_CAP_PX at its
      // own depth); with none, it stays on its wire at that floor — the gates
      // are scripts/view3d-quality/run.mjs "every connection label plate sits
      // on its own wire" and "no connection label plate overlaps a card or a
      // drum on screen where its wire had a free stretch".
      const vp = this.rig.getViewport()
      if (vp.width > 1 && vp.height > 1) {
        const cam = new THREE.PerspectiveCamera(framing.fov, vp.width / vp.height, 10, 200_000)
        applyPose(cam, framing)
        cam.updateMatrixWorld()
        this.connLayer.updateWorldMatrix(true, false)
        const layerM = this.connLayer.matrixWorld
        const v = new THREE.Vector3()
        const screen = (x: number, y: number, z: number, local: boolean) => {
          v.set(x, y, z)
          if (local) v.applyMatrix4(layerM)
          v.project(cam)
          return { x: ((v.x + 1) / 2) * vp.width, y: ((1 - v.y) / 2) * vp.height }
        }
        // the drums' floor tags are obstacles too (TASK 2: 'consumes' lay
        // over the Kafka / 'Event bus' tag in tp3-final-dpr1 and tp4-cards-3
        // workbench-labels.png) — flat, so they hide nothing (no blocker)
        const allSolids = this.nodeSolids()
        const solidPts = allSolids.filter((n) => n.kind !== 'tag')
        const tagPts = allSolids.filter((n) => n.kind === 'tag')
        // ...and every head, fixed at its target wall (fifth arrow
        // iteration: a head stood through 'reads' / 'queries' / 'consumes',
        // connLabelPlacement.resolveScreenLabels has the measurement) — it
        // hides nothing a plate needs (no blocker), it must not be covered
        const headHulls = this.inkHeadHulls(cam, vp.height, (p) => screen(p.x, p.y, p.z, true))
        const solids = [
          ...[...solidPts, ...tagPts].map((n) => convexHull(n.pts.map((p) => screen(p.x, p.y, p.z, false)))),
          ...headHulls,
        ]
        /** Does a node stand between the camera and this world point? (a
         * plate drawn over a node's wall still reads; one behind it does
         * not.) Cards: their slab + plinth box; drums: their cylinder. */
        const ray = new THREE.Ray()
        const hit = new THREE.Vector3()
        // a card's solid is its slab box (points 0-7) and its plinth rim box
        // (8-15) — not their hull, which would wrap the 7-px rim the whole
        // slab height and call a plate in front of the wall hidden
        // (index = its solid's, so only the solids a plate meets on screen
        // are ray-tested — the fallback below runs this for every spot)
        const blockers = [
          ...solidPts.map((n) => {
            const groups = n.kind === 'card' ? [n.pts.slice(0, 8), n.pts.slice(8)] : [n.pts]
            return groups
              .filter((g) => g.length > 0)
              .map((g) => {
                const b = new THREE.Box3().setFromPoints(g.map((p) => new THREE.Vector3(p.x, p.y, p.z)))
                return { kind: n.kind, box: b, cx: (b.min.x + b.max.x) / 2, cz: (b.min.z + b.max.z) / 2, r: (b.max.x - b.min.x) / 2 }
              })
          }),
          ...tagPts.map(() => []),
          ...headHulls.map(() => []),
        ]
        const rayHit = new THREE.Vector3()
        const occluded = (p: THREE.Vector3, near: readonly number[]): boolean => {
          const o = cam.position
          const len = p.distanceTo(o)
          const dx = (p.x - o.x) / len
          const dy = (p.y - o.y) / len
          const dz = (p.z - o.z) / len
          for (const b of near.flatMap((i) => blockers[i])) {
            if (b.kind === 'card') {
              ray.set(o, hit.set(dx, dy, dz))
              const at = ray.intersectBox(b.box, rayHit)
              if (at && at.distanceTo(o) < len - 0.5) return true
              continue
            }
            // the drum's lid disk, then its wall
            const sLid = (b.box.max.y - o.y) / dy
            if (sLid > 0 && sLid < len - 0.5 && Math.hypot(o.x + dx * sLid - b.cx, o.z + dz * sLid - b.cz) <= b.r) return true
            const ox = o.x - b.cx
            const oz = o.z - b.cz
            const qa = dx * dx + dz * dz
            const qb = 2 * (ox * dx + oz * dz)
            const qc = ox * ox + oz * oz - b.r * b.r
            const disc = qb * qb - 4 * qa * qc
            if (qa < 1e-12 || disc < 0) continue
            for (const s of [(-qb - Math.sqrt(disc)) / (2 * qa), (-qb + Math.sqrt(disc)) / (2 * qa)]) {
              const y = o.y + dy * s
              if (s > 0 && s < len - 0.5 && y >= b.box.min.y && y <= b.box.max.y) return true
            }
          }
          return false
        }
        /** How many of the plate's 3 x 3 sample points a node hides — only
         * a node its screen quad `q` meets can. */
        const sampleP = new THREE.Vector3()
        const plateHidden = (box: Box, k: number, anchor: { x: number; y: number } | undefined, lift: number, q: { x: number; y: number }[]): number => {
          const near: number[] = []
          const qb = bbox(q)
          solids.forEach((h, i) => {
            if (!apart(qb, solidBoxes[i], 0) && convexOverlap(q, h, 0)) near.push(i)
          })
          if (near.length === 0) return 0
          const g = scaleAbout(box, k, anchor)
          const y = lift + 0.4
          let n = 0
          for (const fx of [0, 0.5, 1]) {
            for (const fz of [0, 0.5, 1]) {
              if (occluded(sampleP.set(g.x + g.w * fx, y, g.y + g.h * fz).applyMatrix4(layerM), near)) n++
            }
          }
          return n
        }
        /** The scale at which a label at this spot reads LABEL_SCREEN_MIN_CAP_PX
         * through the framing camera AT ITS OWN DEPTH. The view-centre
         * estimate (capFit) undersold the far labels: 'consumes' / 'notifies'
         * held to it measured 7.2 / 7.7 px at the top of the board
         * (textLegibility, this pass's first on-wire probe, DPR 1). */
        const CAP = CONN_LABEL_SIZE_LIT * INTER_CAP_EM
        const floorAt = (spot: LabelSpot): number => {
          const y = spot.at.lift + 0.55
          const a = screen(spot.at.x, y, spot.at.y, true)
          const b = screen(spot.at.x, y, spot.at.y - CAP, true)
          const px = Math.hypot(b.x - a.x, b.y - a.y)
          return Math.max(1, LABEL_SCREEN_MIN_CAP_PX / Math.max(1e-6, px))
        }
        const quad = (box: Box, k: number, anchor: { x: number; y: number } | undefined, lift: number) => {
          const g = scaleAbout(box, k, anchor)
          const y = lift + 0.4
          return convexHull([
            screen(g.x, y, g.y, true),
            screen(g.x + g.w, y, g.y, true),
            screen(g.x + g.w, y, g.y + g.h, true),
            screen(g.x, y, g.y + g.h, true),
          ])
        }
        // …and of every OTHER label plate as it stands on screen: the board
        // settle keeps plates from overlapping, not from touching ('queries'
        // and 'searches' printed edge to edge in tp2-labels probes)
        let mates: { x: number; y: number }[][] = []
        /** Screen bounding boxes: two hulls whose boxes are `margin` apart
         * along x or y are at least that far apart, so the exact
         * separating-axis test is skipped for them (the on-wire search runs
         * it for ~75 spots x every node; the label pass measured 24-26 ms a
         * build without this, tp3 probe, DPR 1). */
        type Hull = { x: number; y: number }[]
        const bbox = (h: Hull) => {
          let x0 = Infinity
          let y0 = Infinity
          let x1 = -Infinity
          let y1 = -Infinity
          for (const p of h) {
            x0 = Math.min(x0, p.x)
            y0 = Math.min(y0, p.y)
            x1 = Math.max(x1, p.x)
            y1 = Math.max(y1, p.y)
          }
          return { x0, y0, x1, y1 }
        }
        const solidBoxes = solids.map(bbox)
        let mateBoxes: ReturnType<typeof bbox>[] = []
        const apart = (a: ReturnType<typeof bbox>, b: ReturnType<typeof bbox>, margin: number) =>
          a.x0 - b.x1 >= margin || b.x0 - a.x1 >= margin || a.y0 - b.y1 >= margin || b.y0 - a.y1 >= margin
        const clear = (q: Hull) => {
          const qb = bbox(q)
          return (
            solids.every((h, j) => apart(qb, solidBoxes[j], LABEL_SCREEN_GAP_PX) || !convexOverlap(q, h, LABEL_SCREEN_GAP_PX)) &&
            mates.every((m, j) => apart(qb, mateBoxes[j], LABEL_SCREEN_GAP_PX) || !convexOverlap(q, m, LABEL_SCREEN_GAP_PX))
          )
        }
        // the scale a label wears at the default framing (applyConnLabelScale)
        const wear = (room: number) => Math.max(1, Math.min(room, kWant))
        /** The largest scale <= `room` (and kWant) at which a plate at this
         * spot is clear of every node on screen, on the growth grid, never
         * under the readable floor `kMin` (the floor wins over the board
         * room: a label that does not read labels nothing); 0 when not even
         * the floor is clear. */
        const clearK = (box: Box, anchor: { x: number; y: number } | undefined, lift: number, room: number, kMin: number): number => {
          // clear(k) only ever turns false as k grows (nested plates): a
          // bisection over the grid top - n x 0.05
          const top = Math.max(wear(room), kMin)
          const at = (n: number) => top - n * 0.05
          let lo = 0 // largest k first
          let hi = Math.floor((top - kMin) / 0.05 + 1e-9)
          if (!clear(quad(box, at(hi), anchor, lift))) return 0
          while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (clear(quad(box, at(mid), anchor, lift))) hi = mid
            else lo = mid + 1
          }
          return at(lo)
        }
        /** How deep plate `q` reaches into `hulls` on screen (0 = clear by
         * the gap). */
        const depth = (q: Hull, hulls: readonly Hull[], boxes: readonly ReturnType<typeof bbox>[]) => {
          const qb = bbox(q)
          // The same maximum, without the exact test for every hull: two
          // convex shapes that overlap penetrate (minus convexGap: the
          // smallest push that separates them, in any direction) by at most
          // the push that separates them along x or along y — and along x
          // that push is their screen boxes' (the projection on x IS the
          // box): min(q.x1 - b.x0, b.x1 - q.x0). Two that do not overlap
          // are >= 0 apart on some edge axis. So a hull adds at most
          // GAP + max(0, min(px, py)) (screenClearance.test.ts holds the
          // bound on 12 720 pairs). Largest bound first; stop once no bound
          // can raise the depth found. (This pass was 597 of 1008 ms of the
          // label pass on 0ob3fum, nearly all in convexGap, connect-freeze
          // profile 2026-10-11.)
          const cand: { u: number; j: number }[] = []
          for (let j = 0; j < hulls.length; j++) {
            const b = boxes[j]
            if (apart(qb, b, LABEL_SCREEN_GAP_PX)) continue
            const px = Math.min(qb.x1 - b.x0, b.x1 - qb.x0)
            const py = Math.min(qb.y1 - b.y0, b.y1 - qb.y0)
            cand.push({ u: LABEL_SCREEN_GAP_PX + Math.max(0, Math.min(px, py)), j })
          }
          cand.sort((a, b) => b.u - a.u)
          let d = 0
          for (const { u, j } of cand) {
            if (u + 1e-9 <= d) break
            d = Math.max(d, LABEL_SCREEN_GAP_PX - convexGap(q, hulls[j]))
          }
          return d
        }
        for (let i = 0; i < this.connLabelScalers.length; i++) {
          yield
          const s = this.connLabelScalers[i]
          mates = this.connLabelScalers.flatMap((o, j) =>
            j === i ? [] : [quad(boxes[j], wear(settled[j]), anchors[j], o.lift)],
          )
          mateBoxes = mates.map(bbox)
          const here: LabelSpot = { box: boxes[i], anchor: anchors[i], at: { x: s.cx, y: s.cz, lift: s.lift, t: s.t, offset: s.offset } }
          if (wear(settled[i]) >= floorAt(here) - 1e-9 && clear(quad(boxes[i], wear(settled[i]), anchors[i], here.at.lift))) continue
          // the board-plane node zones are what failed here: the nodes are
          // tested on screen instead, the other wires and the other labels
          // (at what they reserve) still bound the growth on the board
          const otherWires = otherWiresFor(i)
          const labelObstacles = labelsFor(i, settled)
          const others = unionSource(otherWires, labelObstacles)
          /** The largest scale `spot` is clear and readable at, else null. */
          const tryAt = (spot: LabelSpot, current: boolean): { spot: LabelSpot; k: number } | null => {
            // another label, or another wire (the plate would hide it)
            if (!current && (overlapsAny(spot.box, labelObstacles) || overlapsAny(spot.box, otherWires))) return null
            // the scaled plates are nested (the anchor is on the box): not
            // clear at the readable floor = not clear at any larger scale
            const kMin = floorAt(spot)
            if (!clear(quad(spot.box, kMin, spot.anchor, spot.at.lift))) return null
            const k = clearK(spot.box, spot.anchor, spot.at.lift, freeScale(spot.box, others, CONN_LABEL_MAX_GROW, spot.anchor), kMin)
            return k > 0 ? { spot, k } : null
          }
          // where it sits (smaller, if that clears it); else the free stretch
          // of its OWN wire nearest its preferred arc position (spotsFor is
          // in that order). The old fallback ranked spots by distance and
          // added rings up to 200 px round the wire point — 'notifies' was
          // left 183 world px off its wire (connLabelWireInfo, tp2 board).
          const spots = spotsFor(i)
          let pick = tryAt(spots[0], true)
          if (!pick) {
            for (const sp of spots.slice(1)) {
              yield
              if ((pick = tryAt(sp, false))) break
            }
          }
          if (!pick) {
            // no stretch of its wire is clear for the WHOLE label at the
            // readable floor: the spot where the longest ABBREVIATION is
            // (labelAbbreviations, nearest its preferred arc position on a
            // tie). What it shows at each framing is decided when the camera
            // settles (resolveConnLabelVisibility) — this only picks where.
            const ladder = labelAbbreviations(s.fullText).slice(1)
            let best: { spot: LabelSpot; k: number; n: number } | null = null
            for (const sp of spots) {
              yield
              if (sp !== spots[0] && overlapsAny(sp.box, labelObstacles)) continue
              const k = floorAt(sp)
              for (let n = 0; n < ladder.length && (!best || n < best.n); n++) {
                const w = approxTextWidth(ladder[n], CONN_LABEL_SIZE_LIT) + 14
                const sub = { x: sp.box.x + (sp.box.w - w) / 2, y: sp.box.y, w, h: sp.box.h }
                if (clear(quad(sub, k, sp.anchor, sp.at.lift))) {
                  best = { spot: sp, k, n }
                  break
                }
              }
              if (best?.n === 0) break
            }
            if (best) pick = { spot: best.spot, k: best.k }
          }
          if (!pick) {
            // no stretch of its wire is clear on screen even for its shortest
            // abbreviation at the readable floor: it is HIDDEN at this
            // framing (resolveConnLabelVisibility) and keeps the spot it
            // comes back on when a closer framing gives it room — on the
            // wire, at the floor, where it is seen whole (no node in front of
            // it), touching no other plate, and reaching least into the
            // nodes — the earliest (nearest its preferred arc position) on a
            // tie.
            // A wire whose whole run lies in the zone a tall drum hides has
            // no such spot at cable height ('searches': 3 of 9 plate points
            // behind the Log store drum at best, tp3 probe): the plate may
            // then float higher over its own wire, as far as the on-wire
            // tolerance allows (centre within half its height + the slack of
            // the cable, in 3D), lowest first.
            const lt = (a: [number, number, number], b: [number, number, number]) =>
              a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] - 1e-6 || (Math.abs(a[1] - b[1]) <= 1e-6 && a[2] < b[2] - 1e-6)))
            // the drawn centreline (connLines — what the harness measures)
            const line = this.connLines.get(s.connId) ?? []
            const toLine = (x: number, y: number, z: number) => {
              let d = Infinity
              for (let j = 1; j < line.length; j++) {
                const a = line[j - 1]
                const b = line[j]
                const ab = [b.x - a.x, b.y - a.y, b.z - a.z]
                const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
                const f = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ab[0] + (y - a.y) * ab[1] + (z - a.z) * ab[2]) / l2)) : 0
                d = Math.min(d, Math.hypot(x - a.x - ab[0] * f, y - a.y - ab[1] * f, z - a.z - ab[2] * f))
              }
              return d
            }
            let best: { spot: LabelSpot; k: number; score: [number, number, number] } | null = null
            for (const sp0 of spots) {
              yield
              if (sp0 !== spots[0] && overlapsAny(sp0.box, labelObstacles)) continue
              const k = floorAt(sp0)
              const g = scaleAbout(sp0.box, k, sp0.anchor)
              const within = (lift: number) =>
                toLine(g.x + g.w / 2, lift + 0.4, g.y + g.h / 2) <= onWireMaxDistance(s.h, k) - 1.5
              for (const d of [0, 4, 8, 12, 16]) {
                const lift = sp0.at.lift + d
                if (d > 0 && !within(lift)) break // farther still only rises higher
                const q = quad(sp0.box, k, sp0.anchor, lift)
                const dm = depth(q, mates, mateBoxes)
                const ds = depth(q, solids, solidBoxes)
                // a spot seen whole already won: only a better [mates, nodes]
                // pair can beat it, and hiding can only make this one worse
                if (best && best.score[0] === 0 && !lt([0, dm, ds], best.score)) continue
                const score: [number, number, number] = [plateHidden(sp0.box, k, sp0.anchor, lift, q), dm, ds]
                const sp = d === 0 ? sp0 : { ...sp0, at: { ...sp0.at, lift } }
                if (!best || lt(score, best.score)) best = { spot: sp, k, score }
                if (score[0] === 0) break // seen whole: no higher float
              }
            }
            pick = { spot: best!.spot, k: best!.k }
          }
          if (pick.spot !== spots[0]) moveTo(i, pick.spot, pick.k)
          // the room it may grow into is now what is clear on screen
          settled[i] = pick.k
          free[i] = pick.k
        }
      }
      // where the settle pass may draw each label (TASK 2): here, then the
      // spots on its own wire whose plate would not cover another wire
      const spotLists: (typeof this.connLabelScalers)[number]['spots'][] = []
      for (let i = 0; i < this.connLabelScalers.length; i++) {
        const otherWires = otherWiresFor(i)
        spotLists.push(
          spotsFor(i)
            .filter((sp, j) => j === 0 || !overlapsAny(sp.box, otherWires))
            .map((sp) => ({ x: sp.at.x, z: sp.at.y, lift: sp.at.lift, t: sp.at.t, offset: sp.at.offset, anchor: sp.anchor })),
        )
        yield
      }
      // COMMIT, in one step: every plate shows its state from here on
      this.labelHold = false
      this.connLabelGrowth = {
        kWant,
        labels: this.connLabelScalers.map((s, i) => ({ connId: s.connId, kFree: settled[i], moved: moved.has(i) })),
      }
      this.connLabelScalers.forEach((s, i) => {
        s.kFree = settled[i]
        // the decor keeps off the label at its LARGEST size too
        if (s.kFree > 1) this.connLabelBoxes.push(scaleAbout(boxes[i], s.kFree, s.anchor))
        s.spots = spotLists[i]
        // home, at k = 1 (a carried plate showed the previous pass's spot
        // and scale): applyConnLabelScale grows it, the resolve below moves
        // it to the spot it shows at
        s.k = 1
        s.plate.position.set(s.cx - s.w / 2, s.lift + 0.4, s.cz - s.h / 2)
        s.plate.scale.set(1, 1, 1)
        s.text.position.set(s.cx, s.lift + 0.55, s.cz)
        s.text.scale.setScalar(1)
      })
      this.applyConnLabelScale()
      // whole, abbreviated or hidden at the current framing (TASK 2)
      this.resolveConnLabelVisibility()
    }
  }

  /** Projected cap height (css px) of a k = 1 lit connection label at the
   * target of `pose` (orthographic estimate: the view-centre scale, the
   * glyph's up axis foreshortened by the polar/azimuth). */
  private connLabelCapPx(pose: { distance: number; fov: number; azimuth: number; polar: number }): number {
    const vh = this.renderer.getSize(this._lodSize).y
    const pxPerWorld = vh / (2 * pose.distance * Math.tan((pose.fov / 2) * (Math.PI / 180)))
    const az = (pose.azimuth * Math.PI) / 180
    const polar = (Math.max(0.5, pose.polar) * Math.PI) / 180
    const upFore = Math.hypot(Math.sin(az), Math.cos(az) * Math.cos(polar))
    return CONN_LABEL_SIZE_LIT * INTER_CAP_EM * pxPerWorld * upFore
  }

  /** The scale a lit label needs at the board's DEFAULT framing — the pose
   * fit-to-screen lands on, clear of the floating chrome (showcaseView's
   * framing), else the bare preset pose — what buildConnections finds room
   * for. (The bare preset pose alone frames ~2x closer than fit-to-screen
   * with both panels open: it asked for k = 1 while the fit shot read
   * 4.7-7.2 px, loop4 fix2.) buildConnections derives the wanted label
   * scale from it (legibleScale of connLabelCapPx) and checks every plate
   * against the cards through a camera at it. */
  private defaultFramingPose(): CameraPose {
    const bounds = this.contentBounds()
    const points = this.safeAreaProvider ? this.nodeFitBoxes().flatMap((b) => b.corners) : []
    const vp = this.rig.getViewport()
    let pose = this.rig.presetPoseFor(this.preset, bounds)
    if (points.length > 0 && vp.width > 1 && vp.height > 1) {
      const m = this.chromeInsets()
      pose = this.rig.fitPoseFor(this.preset, bounds, points, {
        left: m.left ?? 0,
        right: m.right ?? 0,
        top: m.top ?? 0,
        bottom: m.bottom ?? 0,
      })
    }
    return pose
  }

  /** Grow each lit connection label toward MIN_CAP_PX of projected cap
   * height, within the room `buildConnections` measured for it (kFree).
   * Called when the camera settles (updateNodeLod) and after a rebuild. */
  private applyConnLabelScale(): boolean {
    // a pending placement pass owns the plates until it commits
    if (this.connLabelScalers.length === 0 || this.labelHold) return false
    const capPx = this.connLabelCapPx(this.rig.getPose())
    let changed = false
    for (const s of this.connLabelScalers) {
      const k = legibleScale(capPx, s.kFree)
      if (Math.abs(k - s.k) < 1e-3) continue
      s.k = k
      const grown = scaleAbout({ x: s.cx - s.w / 2, y: s.cz - s.h / 2, w: s.w, h: s.h }, k, s.anchor)
      s.text.scale.setScalar(k)
      s.text.position.x = grown.x + grown.w / 2
      s.text.position.z = grown.y + grown.h / 2
      s.plate.scale.set(k, 1, k)
      s.plate.position.x = grown.x
      s.plate.position.z = grown.y
      changed = true
    }
    return changed
  }

  /** What each lit connection label SHOWS at the current framing (quality
   * pass "labels", TASK 2 — connLabelPlacement.resolveScreenLabels has the
   * measurement): whole when its plate, as drawn at the scale it wears, is
   * clear on screen of every card, drum, drum tag and every plate already
   * drawn; else its longest abbreviation that is; else hidden. The hovered
   * connection and the selected ones show whole. Runs when the camera
   * settles (updateNodeLod), after a connection build and when the hovered
   * connection changes — a handful of projections per label and node, no
   * material and no light, so no program is ever linked by it. True when a
   * label changed. */
  private resolveConnLabelVisibility(): boolean {
    // a pending placement pass resolves when it commits
    if (this.connLabelScalers.length === 0 || this.labelHold) return false
    const resolveT0 = performance.now()
    const vp = this.rig.getViewport()
    if (vp.width <= 1 || vp.height <= 1) return false
    const cam = this.rig.camera
    cam.updateMatrixWorld()
    this.connLayer.updateWorldMatrix(true, false)
    const layerM = this.connLayer.matrixWorld
    const v = new THREE.Vector3()
    const screen = (x: number, y: number, z: number, local: boolean) => {
      v.set(x, y, z)
      if (local) v.applyMatrix4(layerM)
      v.project(cam)
      return { x: ((v.x + 1) / 2) * vp.width, y: ((1 - v.y) / 2) * vp.height }
    }
    const obstacles = this.nodeSolids().map((n) => convexHull(n.pts.map((p) => screen(p.x, p.y, p.z, false))))
    const forced = new Set<string>(this.selectedIds)
    if (this.connLabelHoverId) forced.add(this.connLabelHoverId)
    const spotsOf = (s: (typeof this.connLabelScalers)[number]) =>
      s.spots.length > 0 ? s.spots : [{ x: s.cx, z: s.cz, lift: s.lift, t: s.t, offset: s.offset, anchor: s.anchor }]
    const labels: ScreenLabel[] = this.connLabelScalers.map((s) => {
      const spots = spotsOf(s)
      // each spot's WHOLE plate projected once (its four corners at the scale
      // it wears); a narrower abbreviated plate is centred in it, so its
      // corners lie on the whole plate's top and bottom edges — taken by
      // interpolation (a straight edge projects straight; the parameter is
      // off by under a tenth of a pixel across a ~100-px plate, inside the
      // 2.5-px gap)
      const corners: { x: number; y: number }[][] = []
      const cornersAt = (j: number) => {
        let c = corners[j]
        if (!c) {
          const sp = spots[j]
          const g = scaleAbout({ x: sp.x - s.w / 2, y: sp.z - s.h / 2, w: s.w, h: s.h }, s.k, sp.anchor)
          const y = sp.lift + 0.4
          c = corners[j] = [
            screen(g.x, y, g.y, true),
            screen(g.x + g.w, y, g.y, true),
            screen(g.x + g.w, y, g.y + g.h, true),
            screen(g.x, y, g.y + g.h, true),
          ]
        }
        return c
      }
      return {
        id: s.connId,
        text: s.fullText,
        forced: forced.has(s.connId),
        spots: spots.length,
        hullFor: (shown: string, j: number) => {
          const [a, b, c, d] = cornersAt(j)
          if (shown === s.fullText) return convexHull([a, b, c, d])
          const u = (1 - this.connLabelPlateW(shown) / s.w) / 2
          const lerp = (p: { x: number; y: number }, q: { x: number; y: number }, f: number) => ({ x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f })
          return convexHull([lerp(a, b, u), lerp(a, b, 1 - u), lerp(d, c, 1 - u), lerp(d, c, u)])
        },
      }
    })
    // the heads stand first (fixed at their target edges): every label
    // keeps clear of them on screen
    const heads = this.inkHeadHulls(cam, vp.height, (p) => screen(p.x, p.y, p.z, true))
    const shows = resolveScreenLabels(labels, obstacles, LABEL_SCREEN_GAP_PX, undefined, heads)
    const resolveMs = performance.now() - resolveT0
    this.connLabelPerf.resolveMs = resolveMs
    this.connLabelPerf.resolveMaxMs = Math.max(this.connLabelPerf.resolveMaxMs, resolveMs)
    this.connLabelPerf.resolves++
    let changed = false
    for (const s of this.connLabelScalers) {
      const show = shows.get(s.connId)
      if (!show) continue
      const sp = spotsOf(s)[show.spot]
      if (show.text !== null && this.placeConnLabel(s, sp)) changed = true
      if (show.state === s.shown.state && show.text === s.shown.text) continue
      this.showConnLabel(s, show)
      changed = true
    }
    return changed
  }

  /** Draw label `s` at on-wire spot `sp` at the scale it wears (its home,
   * `cx`/`cz`, is left alone — the next framing may bring it back there).
   * True when it moved. */
  private placeConnLabel(
    s: (typeof this.connLabelScalers)[number],
    sp: (typeof this.connLabelScalers)[number]['spots'][number],
  ): boolean {
    const g = scaleAbout({ x: sp.x - s.w / 2, y: sp.z - s.h / 2, w: s.w, h: s.h }, s.k, sp.anchor)
    const y = sp.lift + 0.4
    const p = s.plate.position
    if (Math.abs(p.x - g.x) < 1e-6 && Math.abs(p.y - y) < 1e-6 && Math.abs(p.z - g.y) < 1e-6) return false
    p.set(g.x, y, g.y)
    s.text.position.set(g.x + g.w / 2, sp.lift + 0.55, g.y + g.h / 2)
    // a grab starts from where it is drawn
    this.connLabelOffsets.set(s.connId, { t: sp.t, offset: sp.offset })
    return true
  }

  /** A lit label plate's width for `text` (buildConnections' rule). */
  private connLabelPlateW(text: string): number {
    return approxTextWidth(text, CONN_LABEL_SIZE_LIT) + 14
  }

  /** Put `show` on label `s`: hidden, or its text and a plate as wide as
   * that text, centred where the whole plate is (so it stays on its wire). */
  private showConnLabel(s: (typeof this.connLabelScalers)[number], show: LabelShow): void {
    s.shown = show
    if (show.text === null) {
      s.plate.visible = false
      s.text.visible = false
      return
    }
    s.plate.visible = true
    s.text.visible = true
    if (String(s.text.text) !== show.text) {
      s.text.text = show.text
      s.text.sync(() => this.requestRender())
    }
    const want = show.state === 'full' ? s.fullGeo : null
    if (want && s.plate.geometry === want) return
    if (!want && s.plate.userData.plateText === show.text) return
    if (s.plate.geometry !== s.fullGeo) s.plate.geometry.dispose()
    if (want) {
      s.plate.geometry = want
      s.plate.userData.plateText = s.fullText
      return
    }
    const w = this.connLabelPlateW(show.text)
    const geo = new THREE.ShapeGeometry(this.boardShape(w, s.h, s.plateR))
    geo.rotateX(-Math.PI / 2)
    geo.translate((s.w - w) / 2, 0, 0)
    s.plate.geometry = geo
    s.plate.userData.plateText = show.text
  }

  /** A flat, per-frame-rewritable stroke on the board (see DynamicStroke) —
   * soft-edged via a cross-axis falloff so a single wide ribbon reads like the
   * 2D engine's shadow-blurred stroke. Raw-sRGB color, no colorspace chunk
   * (the wall/floor-shader exactness trick). */
  private makeStroke(samples: number, css: string, alpha: number, soft: number, y: number, additive: boolean): DynamicStroke {
    const vertCount = (samples + 1) * 2
    const positions = new Float32Array(vertCount * 3)
    const vs = new Float32Array(vertCount)
    for (let i = 0; i <= samples; i++) {
      vs[i * 2] = 1
      vs[i * 2 + 1] = -1
    }
    const geo = new THREE.BufferGeometry()
    const posAttr = new THREE.BufferAttribute(positions, 3)
    geo.setAttribute('position', posAttr)
    geo.setAttribute('aV', new THREE.BufferAttribute(vs, 1))
    const idx: number[] = []
    for (let i = 0; i < samples; i++) {
      const b = i * 2
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2)
    }
    geo.setIndex(idx)
    const uColor: THREE.IUniform<THREE.Color> = { value: this.srgbUniform(css) }
    const uAlpha: THREE.IUniform<number> = { value: alpha }
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uColor, uAlpha, uSoft: { value: soft } },
      vertexShader: /* glsl */ `
        attribute float aV;
        varying float vV;
        void main() {
          vV = aV;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uAlpha;
        uniform float uSoft;
        varying float vV;
        void main() {
          float edge = uSoft > 0.0 ? pow(max(0.0, 1.0 - abs(vV)), uSoft) : 1.0;
          gl_FragColor = vec4(uColor, uAlpha * edge);
        }
      `,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.y = y
    mesh.frustumCulled = false // centerline rewrites every frame
    this.connLayer.add(mesh)

    const cx = new Float32Array(samples + 1)
    const cz = new Float32Array(samples + 1)
    const chw = new Float32Array(samples + 1)
    const out = { x: 0, z: 0, hw: 1 }
    const update = (fn: (i: number, t: number, o: typeof out) => void) => {
      for (let i = 0; i <= samples; i++) {
        fn(i, i / samples, out)
        cx[i] = out.x
        cz[i] = out.z
        chw[i] = out.hw
      }
      for (let i = 0; i <= samples; i++) {
        const p = Math.max(0, i - 1)
        const q = Math.min(samples, i + 1)
        let tx = cx[q] - cx[p]
        let tz = cz[q] - cz[p]
        const len = Math.hypot(tx, tz) || 1
        tx /= len
        tz /= len
        const nx = -tz * chw[i]
        const nz = tx * chw[i]
        const b = i * 6
        positions[b] = cx[i] + nx
        positions[b + 1] = 0
        positions[b + 2] = cz[i] + nz
        positions[b + 3] = cx[i] - nx
        positions[b + 4] = 0
        positions[b + 5] = cz[i] - nz
      }
      posAttr.needsUpdate = true
    }
    return { mesh, uColor, uAlpha, update }
  }

  /** A static overlay ribbon along the connection whose fragment shader owns
   * the animation (gradient-flow / pulse / neon-dash / energy-beam). `frag`
   * sees varyings vT (arc 0→1) and vV (cross −1→+1) + uBase/uTint + extras. */
  private fxBand(
    pts: { x: number; y: number }[],
    width: number,
    anim: ResolvedConnectionAnimation,
    extras: Record<string, THREE.IUniform<number>>,
    frag: string,
  ): THREE.Mesh | null {
    const geo = buildRibbon(pts, width, null, true)
    if (!geo) return null
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uBase: { value: this.srgbUniform(anim.color) },
        uTint: { value: this.srgbUniform(anim.highlight) },
        ...extras,
      },
      vertexShader: /* glsl */ `
        attribute float aT;
        attribute float aV;
        varying float vT;
        varying float vV;
        void main() {
          vT = aT;
          vV = aV;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `uniform vec3 uBase;\nuniform vec3 uTint;\nvarying float vT;\nvarying float vV;\n${frag}`,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.y = 0.6
    this.connLayer.add(mesh)
    return mesh
  }

  /** The 2D focus animation (renderConnectionHighlightEffect), ported style by
   * style — every style keeps its flat algorithm, theme colors and timing:
   *
   *   traveling-dot  glow/halo/core packet, 1500ms cycle
   *   sparkle        six offset sine-fading dots + the subtle base glow line
   *   gradient-flow  wrapping gradient band, 2000ms cycle
   *   pulse          four expanding width-rings + bright center, 1400ms
   *   neon-dash      10/6 dash train sliding at 0.06px/ms, neon glow layers
   *   lightning      two jittered bolts growing source→target + strike flash
   *   energy-beam    aura/mid/core beam breathing at 0.004rad/ms + packet
   *   strands        3-strand helical rope (twist 1.04, taper 3.1), additive
   *                  bloom on dark boards, depth-ordered weave, spine included
   *   electric       3-octave summed-sine turbulent arc, glow→arc→white core,
   *                  with the 2D flicker
   */
  private buildFlowEffect(
    geom: PathGeometry,
    pts: { x: number; y: number }[],
    width: number,
    anim: ResolvedConnectionAnimation,
    /** Lit ink lines: the line's core and its rim colour — a traveling dot
     * whose colour is within 2:1 of the core (the coral 'Point mobile' dot on
     * the coral highlight) is drawn cream, ringed in the rim ink. */
    guard: { coreCss: string; rimCss: string } | null = null,
  ): void {
    const style = this.highlightStyle
    const unit: FlowUnit = { kind: style, geom, tick: () => {} }
    const span = Math.hypot(geom.toEdge.x - geom.fromEdge.x, geom.toEdge.y - geom.fromEdge.y)
    const TAU = Math.PI * 2

    // flat glow/core discs — board decals like everything else on this layer.
    // Never tone-mapped: flow sparks are emissive accents whose colors must
    // survive a lit theme's ACES pass (no-op under the unlit profile).
    const disc = (r: number, css: string, opacity: number, blob: boolean, y: number) => {
      const mat = new THREE.MeshBasicMaterial({
        color: colorAlpha(css).color,
        transparent: true,
        opacity,
        depthWrite: false,
        toneMapped: false,
        ...(blob ? { alphaMap: blobTexture() } : {}),
      })
      const mesh = new THREE.Mesh(blob ? new THREE.PlaneGeometry(r * 2, r * 2) : new THREE.CircleGeometry(r, 24), mat)
      mesh.rotation.x = -Math.PI / 2
      mesh.position.y = y
      return { mesh, mat }
    }

    // 2D traveling-dot anatomy: base glow r8 @.25 → white r4 → base core r2.5.
    // Lit ink line, dot colour within 2:1 of the line's core: the core disc
    // goes cream and a ring of the rim ink circles the white disc, so the
    // packet still reads on its own line.
    const travelingDot = (cycle: number): ((now: number) => void) => {
      const dot = new THREE.Group()
      const clash = guard !== null && contrastRatio(colorAlpha(anim.color).color, colorAlpha(guard.coreCss).color) < 2
      dot.add(
        disc(9, anim.color, 0.35, true, 0).mesh,
        disc(4, '#FFFFFF', 0.95, false, 0.1).mesh,
        disc(2.5, clash ? '#FBF4E8' : anim.color, 1, false, 0.2).mesh,
      )
      if (clash && guard) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(4, 5, 24),
          new THREE.MeshBasicMaterial({ color: colorAlpha(guard.rimCss).color, transparent: true, depthWrite: false, toneMapped: false }),
        )
        ring.rotation.x = -Math.PI / 2
        ring.position.y = 0.15
        dot.add(ring)
      }
      dot.position.y = 1.0
      // a translucent spark that travels: the arrow probe does not count it
      // as covering a line
      dot.userData.flowSpark = true
      this.connLayer.add(dot)
      unit.dot = dot
      return (now) => {
        const t = (now % cycle) / cycle
        unit.lastT = t
        const p = pathPoint(geom, t)
        dot.position.set(p.x, dot.position.y, p.y)
      }
    }

    // The path is static for the unit's lifetime — pre-sample points + normals
    // once so per-frame work is pure trig (strands/electric/lightning).
    const sampled = (n: number) => {
      const px = new Float32Array(n + 1)
      const pz = new Float32Array(n + 1)
      const nx = new Float32Array(n + 1)
      const nz = new Float32Array(n + 1)
      for (let i = 0; i <= n; i++) {
        const t = i / n
        const p = pathPoint(geom, t)
        const tan = pathTangent(geom, t)
        px[i] = p.x
        pz[i] = p.y
        nx[i] = -tan.y
        nz[i] = tan.x
      }
      return { px, pz, nx, nz }
    }

    switch (style) {
      case 'traveling-dot': {
        unit.tick = travelingDot(1500)
        break
      }

      case 'sparkle': {
        // subtle glow line underneath (2D: base @0.2, width 4)
        const under = this.makeStroke(48, anim.color, 0.2, 1.4, 0.6, false)
        const base = sampled(48)
        under.update((i, _t, o) => {
          o.x = base.px[i]
          o.z = base.pz[i]
          o.hw = 2
        })
        const sparks: { obj: THREE.Object3D; core: THREE.MeshBasicMaterial; glow: THREE.MeshBasicMaterial }[] = []
        for (let i = 0; i < 6; i++) {
          const s = new THREE.Group()
          const glow = disc(5, anim.highlight, 0.5, true, 0)
          const core = disc(2, '#FFFFFF', 1, false, 0.1)
          s.add(glow.mesh, core.mesh)
          s.position.y = 1.0
          this.connLayer.add(s)
          sparks.push({ obj: s, core: core.mat, glow: glow.mat })
        }
        const cycle = 1800
        unit.tick = (now) => {
          unit.lastT = (now % cycle) / cycle
          for (let i = 0; i < sparks.length; i++) {
            const s = sparks[i]
            const localT = ((now + (i / sparks.length) * cycle) % cycle) / cycle
            const fade = Math.sin(localT * Math.PI)
            const p = pathPoint(geom, localT)
            s.obj.position.set(p.x, s.obj.position.y, p.y)
            const scale = 0.5 + fade
            s.obj.scale.set(scale, 1, scale)
            s.core.opacity = fade
            s.glow.opacity = fade * 0.5
          }
        }
        break
      }

      case 'gradient-flow': {
        const uHead: THREE.IUniform<number> = { value: 0 }
        this.fxBand(pts, Math.max(width + 2.2, 5), anim, { uHead }, /* glsl */ `
          uniform float uHead;
          void main() {
            float d = abs(vT - uHead);
            d = min(d, 1.0 - d); // the 2D gradient wraps around its cycle
            float band = smoothstep(0.28, 0.0, d);
            vec3 col = mix(uBase, uTint, band);
            gl_FragColor = vec4(col, band * 0.95);
          }
        `)
        unit.tick = (now) => {
          unit.lastT = uHead.value = (now % 2000) / 2000
        }
        break
      }

      case 'pulse': {
        // 2D: four rings expanding as width 2→14 while fading, + bright center
        const uHead: THREE.IUniform<number> = { value: 0 }
        this.fxBand(pts, 28, anim, { uHead }, /* glsl */ `
          uniform float uHead;
          void main() {
            float av = abs(vV) * 14.0;
            float a = 0.0;
            for (int i = 0; i < 4; i++) {
              float rt = fract(uHead + float(i) * 0.25);
              float w = (2.0 + rt * 12.0) * 0.5;
              a += (1.0 - rt) * 0.35 * (1.0 - smoothstep(w - 0.8, w + 0.3, av));
            }
            float core = 1.0 - smoothstep(0.9, 1.5, av);
            vec3 col = mix(uBase, uTint, core);
            gl_FragColor = vec4(col, min(1.0, a + core * 0.8));
          }
        `)
        unit.tick = (now) => {
          unit.lastT = uHead.value = (now % 1400) / 1400
        }
        break
      }

      case 'neon-dash': {
        // 2D: 10/6 dash pattern sliding at 0.06px/ms under neon glow layers
        let arc = 0
        for (let i = 1; i < pts.length; i++) arc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
        const uOffset: THREE.IUniform<number> = { value: 0 }
        const uLen: THREE.IUniform<number> = { value: arc }
        this.fxBand(pts, 12, anim, { uOffset, uLen }, /* glsl */ `
          uniform float uOffset;
          uniform float uLen;
          void main() {
            float d = mod(vT * uLen - uOffset, 16.0);
            float on = 1.0 - smoothstep(9.6, 10.6, d);
            float av = abs(vV) * 6.0;
            float glow = 0.5 * pow(max(0.0, 1.0 - av / 6.0), 1.6);
            float mid = 0.8 * (1.0 - smoothstep(1.4, 1.9, av));
            float core = 1.0 - smoothstep(0.6, 0.95, av);
            vec3 col = mix(uBase, uTint, clamp(mid + core, 0.0, 1.0));
            gl_FragColor = vec4(col, on * min(1.0, glow + mid + core * 0.9));
          }
        `)
        unit.tick = (now) => {
          uOffset.value = (now * 0.06) % 16
          unit.lastT = uOffset.value / 16
        }
        break
      }

      case 'energy-beam': {
        // 2D: aura(14) / mid(8) / core(3) breathing beam + traveling packet
        const uIntensity: THREE.IUniform<number> = { value: 1 }
        this.fxBand(pts, 14, anim, { uIntensity }, /* glsl */ `
          uniform float uIntensity;
          void main() {
            float av = abs(vV) * 7.0;
            float aura = 0.2 * (1.0 - smoothstep(4.0, 7.0, av));
            float mid = 0.4 * (1.0 - smoothstep(2.5, 4.0, av));
            float core = 0.9 * (1.0 - smoothstep(1.1, 1.6, av));
            vec3 col = mix(uBase, uTint, smoothstep(0.4, 0.9, core));
            gl_FragColor = vec4(col, min(1.0, aura + mid + core) * uIntensity);
          }
        `)
        const dotTick = travelingDot(1200)
        unit.tick = (now) => {
          dotTick(now)
          uIntensity.value = 0.6 + 0.4 * Math.sin(now * 0.004)
        }
        break
      }

      case 'lightning': {
        // 2D: bolt grows source→target over 1600ms; jitter is a fast sine on
        // the CHORD normal enveloped inside the grown span; two bolts + flash
        const N = 24
        const base = sampled(N)
        const chord = Math.atan2(geom.toEdge.y - geom.fromEdge.y, geom.toEdge.x - geom.fromEdge.x) + Math.PI / 2
        const cnx = Math.cos(chord)
        const cnz = Math.sin(chord)
        const bolts = [
          { st: this.makeStroke(N, anim.highlight, 0.6, 0.8, 0.64, false), hw: 1.25, seedOff: 0 },
          { st: this.makeStroke(N, anim.highlight, 0.35, 1.4, 0.62, false), hw: 2, seedOff: Math.PI },
        ]
        const flashCore = disc(3, '#FFFFFF', 0.9, false, 0.2)
        const flashGlow = disc(7, anim.highlight, 0.4, true, 0.1)
        const flash = new THREE.Group()
        flash.add(flashGlow.mesh, flashCore.mesh)
        flash.position.y = 1.0
        this.connLayer.add(flash)
        const cycle = 1600
        unit.tick = (now) => {
          const maxT = (now % cycle) / cycle
          unit.lastT = maxT
          const timeSeed = now * 0.018
          for (const b of bolts) {
            b.st.update((i, t, o) => {
              const grown = t <= maxT
              const env = grown ? Math.sin((t / Math.max(0.001, maxT)) * Math.PI) : 0
              const jitter = Math.sin(t * 40 + timeSeed + b.seedOff) * 5 * env
              o.x = base.px[i] + cnx * jitter
              o.z = base.pz[i] + cnz * jitter
              o.hw = grown ? b.hw : 0
            })
          }
          flash.visible = maxT > 0.01
          const lead = pathPoint(geom, Math.min(1, maxT))
          flash.position.set(lead.x, flash.position.y, lead.y)
        }
        break
      }

      case 'strands': {
        // drawStrands ported to the board: 3 strands orbit the path laterally
        // (the 2D swing IS perpendicular-to-path), depth = cos(orbit) drives
        // weave order + brightness + core whitening; additive bloom on dark.
        // Engine params: radius span·0.021∈[4,14], twist 1.04, thickness 1.35,
        // taper 3.1, speed 0.002, spread 0.2, intensity 0.2 → alphaMul 0.5.
        const S = 48
        const base = sampled(S)
        const R = Math.max(4, Math.min(14, span * 0.021))
        const TWIST = 1.04
        const SPEED = 0.002
        const TH = 1.35
        const TAPER = 3.1
        const SPREAD = 0.2
        const alphaMul = 0.5
        const additive = this.palette!.dark
        // spine — the connection line itself, energized (static)
        const spineCss = anim.strands[0]
        const spineGlow = this.makeStroke(S, spineCss, (additive ? 0.34 : 0.44) * alphaMul * 1.6, 1.6, 0.6, additive)
        const spineCore = this.makeStroke(
          S,
          mixColors(spineCss, '#FFFFFF', additive ? 0.6 : 0.35),
          0.9 * alphaMul,
          0,
          0.62,
          additive,
        )
        const fillSpine = (hw: number) => (i: number, _t: number, o: { x: number; z: number; hw: number }) => {
          o.x = base.px[i]
          o.z = base.pz[i]
          o.hw = hw
        }
        spineGlow.update(fillSpine(TH * 1.0))
        spineCore.update(fillSpine(TH * 0.45))
        const COUNT = 3
        const sx = new Float32Array(S + 1)
        const sz = new Float32Array(S + 1)
        const strands = Array.from({ length: COUNT }, (_, s) => {
          const color = anim.strands[s % anim.strands.length]
          return {
            color,
            phase: (s / COUNT) * TAU,
            fan: (s - (COUNT - 1) / 2) * SPREAD * R,
            glow: this.makeStroke(S, color, 0.3, 2.2, 0.66, additive),
            core: this.makeStroke(S, color, 0.9, 0, 0.68, additive),
            coreLo: this.srgbUniform(color),
            coreHi: this.srgbUniform(mixColors(color, '#FFFFFF', 0.5)),
          }
        })
        unit.tick = (now) => {
          const flow = (now * SPEED) % TAU
          unit.lastT = flow / TAU
          for (const st of strands) {
            let depthSum = 0
            for (let i = 0; i <= S; i++) {
              const t = i / S
              const env = Math.pow(Math.sin(t * Math.PI), TAPER)
              const ang = st.phase + t * TWIST * TAU - flow
              const lat = (Math.sin(ang) * R + st.fan) * env
              sx[i] = base.px[i] + base.nx[i] * lat
              sz[i] = base.pz[i] + base.nz[i] * lat
              depthSum += Math.cos(ang)
            }
            const front = (depthSum / (S + 1) + 1) / 2
            const dA = (0.5 + 0.5 * front) * alphaMul
            st.glow.uAlpha.value = (additive ? 0.7 : 0.55) * dA
            st.core.uAlpha.value = (additive ? 1.9 : 1.8) * dA
            st.core.uColor.value.copy(st.coreLo).lerp(st.coreHi, additive ? front : 0)
            // painter's order on orbit depth — the over/under weave
            st.glow.mesh.renderOrder = 40 + Math.round(front * 10) * 2
            st.core.mesh.renderOrder = 41 + Math.round(front * 10) * 2
            const gw = TH * 1.7
            const cw = TH * 0.55
            st.glow.update((i, _t, o) => {
              o.x = sx[i]
              o.z = sz[i]
              o.hw = gw
            })
            st.core.update((i, _t, o) => {
              o.x = sx[i]
              o.z = sz[i]
              o.hw = cw
            })
          }
        }
        break
      }

      case 'electric': {
        // 2D: three-octave summed-sine turbulence flowing over time, tapered
        // at the ends, drawn glow → tighter counter-arc → white-hot core with
        // the double-sine flicker.
        const N = 64
        const base = sampled(N)
        const amp = Math.max(3, Math.min(8, span * 0.02))
        const ec = anim.electric
        const layers = [
          { st: this.makeStroke(N, ec, 0.42, 1.8, 0.6, false), aScale: 1, seed: 0, spd: 7, hw: 2.25, a: 0.5 },
          { st: this.makeStroke(N, ec, 0.6, 1.2, 0.62, false), aScale: 0.62, seed: 2.4, spd: -6, hw: 1.2, a: 0.6 },
          { st: this.makeStroke(N, mixColors(ec, '#FFFFFF', 0.72), 0.95, 0, 0.64, false), aScale: 1, seed: 0, spd: 7, hw: 0.7, a: 0.95 },
        ]
        unit.tick = (now) => {
          const tt = now * 0.001
          const flick = 0.72 + 0.28 * Math.sin(now * 0.021) * Math.sin(now * 0.037)
          unit.lastT = (now % 1000) / 1000
          for (const L of layers) {
            L.st.uAlpha.value = L.a * flick
            L.st.update((i, t, o) => {
              const env = Math.sin(t * Math.PI)
              const noise =
                Math.sin(t * 8 * Math.PI + L.seed + tt * L.spd) +
                0.55 * Math.sin(t * 17 * Math.PI + L.seed * 1.7 - tt * L.spd * 1.4) +
                0.3 * Math.sin(t * 33 * Math.PI + L.seed * 2.3 + tt * L.spd * 1.9)
              const d = noise * amp * L.aScale * env
              o.x = base.px[i] + base.nx[i] * d
              o.z = base.pz[i] + base.nz[i] * d
              o.hw = L.hw
            })
          }
        }
        break
      }
    }

    this.flowUnits.push(unit)
    this.requestRender()
  }

  /** Exactly one item selected AND it is a connection — the 2D engine's
   * gate for showing endpoint/bend edit handles. */
  private singleSelectedConnId(): string | null {
    if (this.selectedIds.size !== 1) return null
    const id: string = this.selectedIds.values().next().value!
    return this.data.connections.some((c) => c.id === id) ? id : null
  }

  private rectOf(id: string): Rect | null {
    const o = this.data.objects.find((x) => x.id === id)
    if (o) return this.objectRect(o)
    const g = this.data.groups.find((x) => x.id === id)
    return g ? this.groupRect(g) : null
  }

  /** Accent endpoint dots, bend dots, the dashed endpoint-drag preview and the
   * hovered shape's 12 anchor dots — the 3D mirror of the 2D edit chrome.
   * Anchor dots render at the shape's LIFTED top face: floor-level dots would
   * hide under neighbouring slabs and steal pointerdowns. */
  private buildConnEditHandles(connId: string, rects: Map<string, Rect>): void {
    // the lit ink line wears the redesigned chrome (editHandle.ts); the
    // unlit skins keep their board-decal dots unchanged
    if (this.renderProfile === 'lit' && this.connLines.has(connId) && this.arrowDebug.some((a) => a.connId === connId && a.ink)) {
      this.buildInkEditHandles(connId, rects)
      return
    }
    const skin = this.skin!
    const conn = this.data.connections.find((c) => c.id === connId)
    const geom = this.connGeoms.get(connId)
    if (!conn || !geom) return
    const edit = this.connEdit
    const accent = skin.connections.highlight
    const paper = skin.connections.labelBg

    const dot = (x: number, y: number, r: number, fill: string, ring: string, pick?: PickTarget, lift = 0.8) => {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 24), this.surface('handle', fill, { depthWrite: false }))
      disc.rotation.x = -Math.PI / 2
      disc.position.set(x, lift, y)
      if (pick) {
        disc.userData.pick = pick
        this.pickables.push(disc)
      }
      this.connLayer.add(disc)
      const band = new THREE.Mesh(new THREE.RingGeometry(r, r + 1.5, 24), this.surface('handle', ring, { depthWrite: false }))
      band.rotation.x = -Math.PI / 2
      band.position.set(x, lift + 0.1, y)
      this.connLayer.add(band)
    }
    // Endpoint dots ride their shape's TOP rim (the lifted-face rule): at floor
    // level the far-side dot hides behind its own slab and can't be grabbed.
    const liftFor = (shapeId: string) => {
      const unit = this.nodeGroups.get(shapeId) ?? this.groupPlates.get(shapeId)
      return ((unit?.userData.topY as number | undefined) ?? 0) + 0.6 - this.connLayer.position.y
    }

    // endpoint handles — the dragged end is replaced by the dashed preview
    const draggingEnd = edit?.mode === 'endpoint' && edit.connId === connId ? edit.end : null
    if (draggingEnd !== 'source')
      dot(geom.fromEdge.x, geom.fromEdge.y, 6, accent, paper, { kind: 'connEndpoint', id: connId, end: 'source' }, liftFor(conn.fromId))
    if (draggingEnd !== 'target')
      dot(geom.toEdge.x, geom.toEdge.y, 6, accent, paper, { kind: 'connEndpoint', id: connId, end: 'target' }, liftFor(conn.toId))

    // bend dots (working copy while dragging)
    const waypoints = edit?.mode === 'waypoint' && edit.connId === connId ? edit.working : (conn.waypoints ?? [])
    waypoints.forEach((wp, i) => dot(wp.x, wp.y, 5, paper, accent, { kind: 'connWaypoint', id: connId, index: i }))

    if (edit?.mode === 'endpoint' && edit.connId === connId && edit.preview) {
      // dashed re-route preview from the fixed edge to the cursor
      const fixedEdge = edit.end === 'source' ? geom.toEdge : geom.fromEdge
      const ribbon = buildRibbon(endpointDragPreview(fixedEdge, edit.preview), 2, [4, 4])
      if (ribbon) {
        const mesh = new THREE.Mesh(ribbon, this.surface('handle', accent, { depthWrite: false, side: THREE.DoubleSide }))
        mesh.position.y = 0.7
        this.connLayer.add(mesh)
      }
      // hovered drop shape: all 12 anchors on its top face, nearest enlarged
      if (edit.hoverShapeId) {
        const rect = rects.get(edit.hoverShapeId)
        const unitOfShape = this.nodeGroups.get(edit.hoverShapeId) ?? this.groupPlates.get(edit.hoverShapeId)
        if (rect) {
          const yLocal = ((unitOfShape?.userData.topY as number | undefined) ?? 0) + 0.4 - this.connLayer.position.y
          const snapped = nearestAnchorIndex(rect, edit.preview.x, edit.preview.y)
          for (let i = 0; i < ANCHOR_COUNT; i++) {
            const a = anchorPoint(rect, i)
            const r = i === snapped ? 5 : 3.5
            const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 20), this.surface('handle', accent, { depthWrite: false }))
            disc.rotation.x = -Math.PI / 2
            disc.position.set(a.x, yLocal, a.y)
            this.connLayer.add(disc)
            const band = new THREE.Mesh(new THREE.RingGeometry(r, r + 1.2, 20), this.surface('handle', paper, { depthWrite: false }))
            band.rotation.x = -Math.PI / 2
            band.position.set(a.x, yLocal + 0.1, a.y)
            this.connLayer.add(band)
          }
        }
      }
    }
  }

  /**
   * The lit board's edit chrome for the selected connection (selected spec
   * v1 §4): screen-aligned billboard handles of constant css size
   * (editHandle.ts) ON the drawn line at its own height — the source handle
   * on the line's first point, the target KNOB on the head's tip (shown per
   * frame: updateEditHandles), bends at their waypoints — the dashed drag
   * preview as an ink line, and the hovered drop shape's 12 anchors on its
   * top face. Front + x-ray meshes share one geometry; both draw above the
   * label plates (order 40+, CONN_LABEL_PLATE_ORDER is 30).
   */
  private buildInkEditHandles(connId: string, rects: Map<string, Rect>): void {
    const skin = this.skin!
    const conn = this.data.connections.find((c) => c.id === connId)
    const line = this.connLines.get(connId)
    const arrow = this.arrowDebug.find((a) => a.connId === connId)
    if (!conn || !line || line.length < 2 || !arrow) return
    const edit = this.connEdit
    const dark = this.palette?.dark === true
    const coral = skin.connections.highlight
    setHandleAppearance(this.handleUniforms, dark, coral)
    type H = NonNullable<typeof this.editChrome>['items'][number]
    const handles: H[] = []
    const draggingEnd = edit?.mode === 'endpoint' && edit.connId === connId ? edit.end : null
    if (draggingEnd !== 'source') {
      handles.push({ role: 'source', kind: 'endpoint', id: 0, x: line[0].x, y: line[0].y, z: line[0].z, visible: true, pick: { kind: 'connEndpoint', id: connId, end: 'source' } })
    }
    if (draggingEnd !== 'target') {
      // shown / hidden every frame (updateEditHandles): visibility is camera-dependent
      handles.push({ role: 'knob', kind: 'endpoint', id: 1, x: arrow.head.x, y: arrow.head.y, z: arrow.head.z, visible: false, pick: { kind: 'connEndpoint', id: connId, end: 'target' } })
    }
    const waypoints = edit?.mode === 'waypoint' && edit.connId === connId ? edit.working : (conn.waypoints ?? [])
    waypoints.forEach((wp, i) =>
      handles.push({ role: 'bend', kind: 'bend', id: 2 + i, x: wp.x, y: 0, z: wp.y, visible: true, pick: { kind: 'connWaypoint', id: connId, index: i } }),
    )
    // pressed: the dragged end (it rides the cursor) or the dragged bend
    let pressId = -1
    if (edit?.mode === 'waypoint' && edit.connId === connId) pressId = 2 + edit.index
    if (edit?.mode === 'endpoint' && edit.connId === connId && edit.preview) {
      pressId = 100
      // the dashed re-route preview: a coral ink line, 2 css px, no rim,
      // from the fixed end's handle to the cursor, under the handles
      const geom = this.connGeoms.get(connId)
      const face = edit.end === 'source' ? geom?.toEdge.face : geom?.fromEdge.face
      const fixed = edit.end === 'source' ? { x: arrow.head.x, y: arrow.head.z } : { x: line[0].x, y: line[0].z }
      const route = face ? endpointDragPreview({ ...fixed, face }, edit.preview) : [fixed, edit.preview]
      // dash 6 / 4 css px: world lengths at the orbit target's scale (the
      // camera holds still during a drag; the layer rebuilds on every move)
      this.updateInkUniforms()
      const wppT = this.inkUniforms.uInkWppTarget.value
      const dashCss: [number, number] = [INK_DASHED[0] * wppT, INK_DASHED[1] * wppT]
      const g = buildInkGeometry({ pts: route, head: null, width: 0, minCss: 2, maxCss: 2, casing: 0, casingMinCss: 0, dash: dashCss })
      if (g) {
        const m = new THREE.Mesh(g, this.inkMaterial(coral, 0.9))
        m.userData.ink = 'preview'
        m.name = 'ink-drag-preview'
        m.renderOrder = 38
        this.connLayer.add(m)
      }
      handles.push({ role: 'drag', kind: 'endpoint', id: 100, x: edit.preview.x, y: 0, z: edit.preview.y, visible: true, pick: null })
      // the hovered drop shape: its 12 anchors on its top face
      if (edit.hoverShapeId) {
        const rect = rects.get(edit.hoverShapeId)
        const unitOfShape = this.nodeGroups.get(edit.hoverShapeId) ?? this.groupPlates.get(edit.hoverShapeId)
        if (rect) {
          const yLocal = ((unitOfShape?.userData.topY as number | undefined) ?? 0) + 0.4 - this.connLayer.position.y
          const snapped = nearestAnchorIndex(rect, edit.preview.x, edit.preview.y)
          for (let i = 0; i < ANCHOR_COUNT; i++) {
            const a = anchorPoint(rect, i)
            handles.push({ role: 'anchor', kind: i === snapped ? 'anchorSnapped' : 'anchor', id: 200 + i, x: a.x, y: yLocal, z: a.y, visible: true, pick: null })
          }
        }
      }
    }
    this.handleUniforms.uPressId.value = pressId
    if (handles.length === 0) return
    const geo = buildHandleGeometry(handles, dark, coral)
    // x-ray first (the ghost behind a card), then the front pass over it
    const xray = new THREE.Mesh(geo, createHandleMaterial(this.inkUniforms, this.handleUniforms, true))
    xray.renderOrder = 40
    xray.name = 'edit-handles-xray'
    xray.userData.sharedGeometry = true
    const front = new THREE.Mesh(geo, createHandleMaterial(this.inkUniforms, this.handleUniforms, false))
    front.renderOrder = 41
    front.name = 'edit-handles'
    this.connLayer.add(xray, front)
    this.editChrome = { connId, geo, items: handles }
    this.updateEditHandles()
  }

  /**
   * Place the target KNOB for this frame's camera (selected spec §4.2):
   * on the head's tip (the 2D destination dot) — and apply the short-line
   * rules (editHandleVisibility) and the occlusion by its own target.
   */
  private updateEditHandles(): void {
    const chrome = this.editChrome
    if (!chrome) return
    const knobIndex = chrome.items.findIndex((h) => h.role === 'knob')
    const srcIndex = chrome.items.findIndex((h) => h.role === 'source')
    const arrow = this.arrowDebug.find((a) => a.connId === chrome.connId)
    const line = this.connLines.get(chrome.connId)
    if (!arrow || !line) return
    const cam = this.rig.camera
    const vp = this.rig.getViewport()
    cam.updateMatrixWorld()
    this.connLayer.updateWorldMatrix(true, false)
    const layerM = this.connLayer.matrixWorld
    const v = new THREE.Vector3()
    const screen = (x: number, y: number, z: number) => {
      v.set(x, y, z).applyMatrix4(layerM).project(cam)
      return { x: ((v.x + 1) / 2) * vp.width, y: ((1 - v.y) / 2) * vp.height }
    }
    const tip = screen(arrow.head.x, arrow.head.y, arrow.head.z)
    // ON the tip, as the 2D canvas draws its destination dot on toEdge: the
    // design spec's knob 5 css px behind the head's base left a gap the user
    // read as "le dot est avant" the arrow (2026-10-12)
    const knob = { x: arrow.head.x, z: arrow.head.z }
    const src = line[0]
    const s0 = screen(src.x, src.y, src.z)
    let linePx = 0
    let prev = tip
    for (let i = line.length - 1; i >= 0; i--) {
      const s = screen(line[i].x, line[i].y, line[i].z)
      linePx += Math.hypot(s.x - prev.x, s.y - prev.y)
      prev = s
    }
    const vis = editHandleVisibility({ knobToSourcePx: Math.hypot(tip.x - s0.x, tip.y - s0.y), linePx })
    const dark = this.palette?.dark === true
    if (knobIndex >= 0) {
      const h = chrome.items[knobIndex]
      // behind its OWN target (the camera beyond a drum): the head is hidden
      // there too, and the x-ray ghost of a knob with no head beside it read
      // as a stray decal on the drum wall (design review round 2,
      // workbench-arrows-selected-line.png, 'ships' into Log store) — the
      // knob hides with its head. Behind any other shape it ghosts (§6).
      const hiddenByTarget = this.occludedByNode(arrow.toId, new THREE.Vector3(knob.x, arrow.head.y, knob.z).applyMatrix4(layerM))
      chrome.knobOccluded = hiddenByTarget
      const show = vis.knob && !hiddenByTarget
      const d = show ? handleStyle(h.kind, dark).diameter : 0
      h.x = knob.x
      h.y = arrow.head.y
      h.z = knob.z
      if (h.visible !== show || show) {
        h.visible = show
        setHandleAnchor(chrome.geo, knobIndex, h.x, h.y, h.z, d)
      }
    }
    if (srcIndex >= 0 && chrome.items[srcIndex].visible !== vis.source) {
      const h = chrome.items[srcIndex]
      h.visible = vis.source
      setHandleAnchor(chrome.geo, srcIndex, h.x, h.y, h.z, vis.source ? handleStyle(h.kind, dark).diameter : 0)
    }
  }

  private occRay = new THREE.Raycaster()
  /** Does node `id`'s SOLID body (depth-written, visible meshes — not its
   * soft shadow decals) stand between the camera and world point `w`? */
  private occludedByNode(id: string, w: THREE.Vector3): boolean {
    const group = this.nodeGroups.get(id)
    if (!group) return false
    const cam = this.rig.camera
    const from = cam.getWorldPosition(new THREE.Vector3())
    const dir = w.clone().sub(from)
    const d = dir.length()
    this.occRay.set(from, dir.normalize())
    this.occRay.far = d - 0.6
    return this.occRay.intersectObject(group, true).some((hit) => {
      for (let n: THREE.Object3D | null = hit.object; n; n = n.parent) if (!n.visible) return false
      const m = (hit.object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      return !!m && !Array.isArray(m) && m.depthWrite && !this.connTexts.includes(hit.object as Text)
    })
  }

  /** The drawn diameter (css px) of edit handle `h` this frame: hovered or
   * pressed grow to HANDLE_D_HOT. */
  private handleDrawnDiameter(h: { kind: EditHandleKind; id: number }): number {
    const u = this.handleUniforms
    const hot = h.id === u.uPressId.value ? 1 : h.id === u.uHoverId.value ? u.uHoverT.value : 0
    return handleStyle(h.kind, this.palette?.dark === true).diameter * (1 + (HANDLE_D_HOT / 10 - 1) * hot)
  }

  /**
   * The flow bead's fade for this frame (selected spec §5, acceptance "never
   * within 12 css px of a handle or the head"): its centre projected, its
   * clearance measured ON SCREEN to the line's start (the source handle's
   * edge when shown), every other drawn handle's edge and the drawn head
   * triangle, and inkPacketFade of it written to the meshes that paint it.
   */
  private updateInkBeads(): void {
    if (this.inkUniforms.uInkPhase.value < 0) return
    const units = this.flowUnits.filter((u) => u.bead && u.pos)
    if (units.length === 0) return
    const cam = this.rig.camera
    const vp = this.rig.getViewport()
    cam.updateMatrixWorld()
    this.connLayer.updateWorldMatrix(true, false)
    const layerM = this.connLayer.matrixWorld
    const v = new THREE.Vector3()
    const screen = (x: number, y: number, z: number) => {
      v.set(x, y, z).applyMatrix4(layerM).project(cam)
      return { x: ((v.x + 1) / 2) * vp.width, y: ((1 - v.y) / 2) * vp.height }
    }
    for (const u of units) {
      const b = u.bead!
      const line = this.connLines.get(b.connId)
      const arrow = this.arrowDebug.find((a) => a.connId === b.connId)
      if (!line || line.length < 2 || !arrow) continue
      const c = screen(u.pos!.x, line[0].y, u.pos!.z)
      const discs: { x: number; y: number; r: number }[] = []
      const chrome = this.editChrome?.connId === b.connId ? this.editChrome : null
      const src = chrome?.items.find((h) => h.role === 'source' && h.visible)
      discs.push({ ...screen(line[0].x, line[0].y, line[0].z), r: src ? this.handleDrawnDiameter(src) / 2 : 0 })
      for (const h of chrome?.items ?? []) {
        if (!h.visible || h === src) continue
        discs.push({ ...screen(h.x, h.y, h.z), r: this.handleDrawnDiameter(h) / 2 })
      }
      let clear = Infinity
      for (const d of discs) clear = Math.min(clear, Math.hypot(c.x - d.x, c.y - d.y) - d.r)
      const tri = this.inkHeadAt(arrow, cam, vp.height).tri.map((q) => screen(q.x, q.y, q.z))
      clear = Math.min(clear, discTriangleGap(c, 0, tri))
      b.clearPx = clear
      b.fade = inkPacketFade(clear)
      for (const k of b.ks) k.value = b.fade
    }
  }

  /** The lit edit handle under client point (x, y), picked on SCREEN (§7):
   * within max(radius + 4, 9) css px of a drawn handle's centre — or, for
   * the target end, anywhere in the selected line's drawn head (the head is
   * part of the target grip). Null otherwise. */
  private editHandleAt(clientX: number, clientY: number): { target: PickTarget; point: THREE.Vector3; id: number } | null {
    const chrome = this.editChrome
    if (!chrome) return null
    const rect = this.canvas.getBoundingClientRect()
    const cam = this.rig.camera
    cam.updateMatrixWorld()
    this.connLayer.updateWorldMatrix(true, false)
    const layerM = this.connLayer.matrixWorld
    const dark = this.palette?.dark === true
    let best: { target: PickTarget; point: THREE.Vector3; id: number; d: number } | null = null
    for (const h of chrome.items) {
      if (!h.visible || !h.pick) continue
      const w = new THREE.Vector3(h.x, h.y, h.z).applyMatrix4(layerM)
      const p = w.clone().project(cam)
      if (p.z < -1 || p.z > 1) continue
      const sx = rect.left + ((p.x + 1) / 2) * rect.width
      const sy = rect.top + ((1 - p.y) / 2) * rect.height
      const d = Math.hypot(sx - clientX, sy - clientY)
      if (d <= handleHitRadius(handleStyle(h.kind, dark).diameter) && (!best || d < best.d)) best = { target: h.pick, point: w, id: h.id, d }
    }
    if (best) return best
    // the head: the target grip
    const arrow = this.arrowDebug.find((a) => a.connId === chrome.connId)
    if (!arrow || !chrome.items.some((h) => h.role === 'knob')) return null
    const tri = this.inkHeadAt(arrow, cam, rect.height).tri.map((q) => {
      const w = new THREE.Vector3(q.x, q.y, q.z).applyMatrix4(layerM)
      const p = w.clone().project(cam)
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, w }
    })
    const side = (a: { x: number; y: number }, b: { x: number; y: number }) => (b.x - a.x) * (clientY - a.y) - (b.y - a.y) * (clientX - a.x)
    const s1 = side(tri[0], tri[1])
    const s2 = side(tri[1], tri[2])
    const s3 = side(tri[2], tri[0])
    if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) {
      return { target: { kind: 'connEndpoint', id: chrome.connId, end: 'target' }, point: tri[0].w, id: 1 }
    }
    return null
  }

  // ── picking & pointer interaction ──────────────────────────────────────────

  private ndc(e: PointerEvent | WheelEvent): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect()
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
  }

  private pickClient(
    clientX: number,
    clientY: number,
    kinds?: ReadonlySet<PickTarget['kind']>,
  ): { target: PickTarget; point: THREE.Vector3 } | null {
    // the lit edit handles draw above everything on the layer (plates
    // included) and pick first, on screen (selected spec §7)
    if (!this.readonly_ && (!kinds || kinds.has('connEndpoint') || kinds.has('connWaypoint'))) {
      const h = this.editHandleAt(clientX, clientY)
      if (h && (!kinds || kinds.has(h.target.kind))) return { target: h.target, point: h.point }
    }
    const rect = this.canvas.getBoundingClientRect()
    this.raycaster.setFromCamera(
      new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1),
      this.rig.camera,
    )
    // Meshes created by a rebuild carry identity matrixWorld until the next
    // rendered frame — a fast follow-up click (dblclick) would raycast THROUGH
    // them and hit whatever sits behind. Refresh matrices before picking.
    this.scene.updateMatrixWorld()
    const hits = this.raycaster.intersectObjects(this.pickables, false)
    // a lit ink line is picked on screen (inkLineAt); what the ray meets
    // before the line's plane — a card, a label plate — still wins (the
    // ray's distance to the line's own height, not to its centreline: a
    // click a few px nearer the camera than the line meets a platform under
    // it nearer than the centreline point)
    const line = !kinds || kinds.has('connection') ? this.inkLineAt(clientX, clientY) : null
    const lineHit = line ? { target: { kind: 'connection', id: line.id } satisfies PickTarget, point: line.point } : null
    const lineDist = line ? (this.raycaster.ray.distanceToPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -line.point.y)) ?? line.distance) : 0
    for (const hit of hits) {
      // Raycaster does NOT skip invisible meshes — an LOD-hidden decoration
      // (e.g. the expand glyph on a far-away card) must not swallow the click.
      if (!hit.object.visible) continue
      if (lineHit && lineDist < hit.distance - 0.5) return lineHit
      const voxelIds = hit.object.userData.voxelIds as string[] | undefined
      if (voxelIds && hit.instanceId !== undefined) {
        const id = voxelIds[hit.instanceId]
        const target: PickTarget | undefined = id ? { kind: 'voxel', id } : undefined
        if (target && (!kinds || kinds.has(target.kind))) return { target, point: hit.point }
      }
      const pick = hit.object.userData.pick as PickTarget | undefined
      if (pick && (!kinds || kinds.has(pick.kind))) return { target: pick, point: hit.point }
    }
    return lineHit
  }

  private pick(e: PointerEvent): { target: PickTarget; point: THREE.Vector3 } | null {
    return this.pickClient(e.clientX, e.clientY)
  }

  /** Intersect the pointer ray with the horizontal plane at `y`. */
  private floorPoint(e: PointerEvent, y: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.rig.camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y)
    const out = new THREE.Vector3()
    return this.raycaster.ray.intersectPlane(plane, out)
  }

  private attach(): void {
    const canvas = this.canvas
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      // every canvas handler is attributed in slowFrameLog as `on:<type>`
      // (a gesture's first pick can be the hitch, not the frame)
      const timed = (e: Event) => this.timedTask(`on:${type}`, () => fn(e as HTMLElementEventMap[K]))
      canvas.addEventListener(type, timed, opts)
      this.detachFns.push(() => canvas.removeEventListener(type, timed))
    }

    // GL context resilience: three's own handlers run first (registered
    // when the WebGLRenderer was constructed) — preventDefault + GL re-init.
    // Ours then pause the on-demand loop while lost and, on restore, force a
    // FULL cache-backed rebuild: the scene graph is recreated so every
    // geometry, canvas texture and troika SDF re-uploads into the new context,
    // and the render kick un-blacks the board (we render on demand, so without
    // it a restored context would just stay blank).
    const onContextLost = (e: Event) => {
      e.preventDefault() // signal the context is restorable (three does too — belt & braces)
      this.contextLost = true
      if (this.raf) {
        cancelAnimationFrame(this.raf)
        this.raf = 0
      }
    }
    const onContextRestored = () => {
      this.contextLost = false
      this.contextRestores++
      // Renderer-level profile state and the PMREM env texture died with the
      // old GL context — re-apply before the rebuild repaints.
      this.applyRenderProfile({ forceEnvRefresh: true })
      // the kept connection programs died with the context too: keep the
      // new context's own (keepConnProgram keys by the program cache key)
      for (const m of this.connProgramKeepers.values()) m.dispose()
      this.connProgramKeepers.clear()
      this.buildSignature = '' // bust the signature → rebuild() does the full pass
      this.rebuild()
    }
    canvas.addEventListener('webglcontextlost', onContextLost, false)
    canvas.addEventListener('webglcontextrestored', onContextRestored, false)
    this.detachFns.push(() => {
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
    })

    on('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId)
      const p = this.pointer
      p.lastX = e.clientX
      p.lastY = e.clientY
      p.moved = false
      p.button = e.button
      p.lastPos = null
      p.groupDrag = null
      this.clearSmartGuides(true)
      if (e.button === 1 || e.button === 2) {
        p.mode = 'pan'
        return
      }
      const hit = this.pick(e)
      if (hit?.target.kind === 'voxel') {
        const live = this.voxelScatter
        const fragment = live?.fragments.get(hit.target.id)
        if (live && fragment) {
          p.mode = 'dragVoxel'
          p.id = fragment.id
          this.voxelAnimations.delete(fragment.id)
          const world = live.floor.localToWorld(fragment.position.clone())
          const fp = this.floorPoint(e, fragment.home.y)
          p.grabDX = (fp?.x ?? world.x) - world.x
          p.grabDZ = (fp?.z ?? world.z) - world.z
          this.setVoxelHover(fragment.id)
          canvas.style.cursor = 'grabbing'
          return
        }
      }
      // connection-edit gestures (2D parity; handles only exist in write mode)
      if (hit && !this.readonly_) {
        const t = hit.target
        if (t.kind === 'connEndpoint') {
          p.mode = 'connEdit'
          this.connEdit = { mode: 'endpoint', connId: t.id, end: t.end, preview: null, hoverShapeId: null }
          // pressed: coral-800 (the lit handles)
          this.handleUniforms.uPressId.value = t.end === 'source' ? 0 : 1
          this.requestRender()
          return
        }
        if (t.kind === 'connWaypoint') {
          const conn = this.data.connections.find((c) => c.id === t.id)
          this.handleUniforms.uPressId.value = 2 + t.index
          this.requestRender()
          p.mode = 'connEdit'
          this.connEdit = {
            mode: 'waypoint',
            connId: t.id,
            index: t.index,
            working: (conn?.waypoints ?? []).map((w) => ({ ...w })),
          }
          return
        }
        if (t.kind === 'connLabel') {
          const conn = this.data.connections.find((c) => c.id === t.id)
          if (conn) {
            // grabbing a label selects its connection (2D behavior) + starts the slide
            if (!this.selectedIds.has(t.id)) this.callbacks.onConnectionSelect(t.id)
            p.mode = 'connEdit'
            this.connEdit = {
              mode: 'label',
              connId: t.id,
              // start from where the label is DRAWN: a lit label may have
              // slid along its wire (or nudged across it) to miss a card, so
              // its stored (t, offset) is not where the pointer grabbed it
              t: this.connLabelOffsets.get(t.id)?.t ?? conn.labelPosition ?? 0.5,
              offset: Math.max(-40, Math.min(40, this.connLabelOffsets.get(t.id)?.offset ?? conn.labelOffset ?? 0)),
            }
          }
          return
        }
        if (t.kind === 'connection' && t.id === this.singleSelectedConnId()) {
          // press on the selected line arms a bend insert — materialized only
          // once the cursor moves, so a plain click doesn't add one
          const geom = this.connGeoms.get(t.id)
          const fp = this.floorPoint(e, this.connLayer.position.y)
          if (geom && fp) {
            p.mode = 'connEdit'
            this.connEdit = {
              mode: 'pending',
              connId: t.id,
              index: nearestSegmentIndex(geom, fp.x, fp.z),
              start: { x: fp.x, y: fp.z },
            }
            return
          }
        }
      }
      if (hit && !this.readonly_ && (hit.target.kind === 'object' || hit.target.kind === 'group')) {
        p.mode = hit.target.kind === 'object' ? 'dragNode' : 'dragGroup'
        p.id = hit.target.id
        const rect =
          hit.target.kind === 'object'
            ? this.objectRect(this.data.objects.find((o) => o.id === hit.target.id)!)
            : this.groupRect(this.data.groups.find((g) => g.id === hit.target.id)!)
        const baseY = this.nodeGroups.get(hit.target.id)?.userData.baseY ?? 0
        const fp = this.floorPoint(e, baseY)
        p.grabDX = (fp?.x ?? rect.x) - rect.x
        p.grabDZ = (fp?.z ?? rect.y) - rect.y
        if (hit.target.kind === 'object') {
          this.captureSmartGuideCandidates(new Set([hit.target.id]))
        }
        if (hit.target.kind === 'group') {
          // capture start positions: dragging a platform carries its members
          // by the same delta (the 2D group-drag contract)
          const grp = this.data.groups.find((g) => g.id === hit.target.id)
          p.groupDrag = startGroupDrag(grp, rect, this.data.groups, this.data.objects, this.objectIdsOnScene())
          this.captureSmartGuideCandidates(new Set(grp?.objectIds ?? []), new Set([hit.target.id]))
        }
      } else if (hit && this.readonly_ && hit.target.kind !== 'connection') {
        p.mode = 'orbit' // read-only: shapes aren't draggable, orbit instead
        p.id = hit.target.id
      } else {
        p.mode = 'orbit'
        p.id = hit?.target.kind === 'connection' ? hit.target.id : null
      }
    })

    on('pointermove', (e) => {
      const p = this.pointer
      const dx = e.clientX - p.lastX
      const dy = e.clientY - p.lastY
      if (p.mode === 'idle') {
        const hit = this.pick(e)
        const kind = hit?.target.kind
        this.setVoxelHover(hit?.target.kind === 'voxel' ? hit.target.id : null)
        this.setConnLabelHover(hit && (hit.target.kind === 'connection' || hit.target.kind === 'connLabel') ? hit.target.id : null)
        // a lit edit handle (or the selected head, the target grip): glow +
        // grow — the head and the knob light together (id 1)
        const ht = hit?.target
        this.setHandleHover(
          this.editChrome && ht
            ? ht.kind === 'connEndpoint'
              ? ht.end === 'source'
                ? 0
                : 1
              : ht.kind === 'connWaypoint'
                ? 2 + ht.index
                : null
            : null,
        )
        canvas.style.cursor =
          !this.readonly_ && (kind === 'connEndpoint' || kind === 'connWaypoint')
            ? 'crosshair'
            : !this.readonly_ && kind === 'connLabel'
              ? 'grab'
              : kind === 'voxel'
                ? 'grab'
              : hit
                ? 'pointer'
                : 'default'
        return
      }
      if (Math.abs(dx) + Math.abs(dy) > 1) p.moved = true
      p.lastX = e.clientX
      p.lastY = e.clientY
      switch (p.mode) {
        case 'orbit':
          this.rig.orbitBy(dx, dy)
          break
        case 'pan':
          this.rig.panBy(dx, dy)
          break
        case 'dragVoxel': {
          const live = this.voxelScatter
          const fragment = p.id ? live?.fragments.get(p.id) : null
          if (!live || !fragment) break
          const fp = this.floorPoint(e, fragment.home.y)
          if (!fp) break
          const localX = fp.x - p.grabDX - live.floor.position.x
          const localZ = fp.z - p.grabDZ - live.floor.position.z
          fragment.position.set(
            localX,
            fragment.home.y + Math.max(this.theme3d?.pixelSnap ?? 1, fragment.size * 0.34),
            localZ,
          )
          fragment.rotationY += dx * 0.025
          this.voxelTransient.set(fragment.id, {
            dx: localX - fragment.home.x,
            dz: localZ - fragment.home.z,
            rotationY: fragment.rotationY,
          })
          this.updateVoxelFragment(fragment)
          this.requestRender()
          break
        }
        case 'dragNode':
        case 'dragGroup': {
          if (!p.id) break
          this.setGridDragging(true)
          const baseY = this.nodeGroups.get(p.id)?.userData.baseY ?? 0
          const fp = this.floorPoint(e, baseY)
          if (!fp) break
          const rawPos = { x: fp.x - p.grabDX, y: fp.z - p.grabDZ }
          const movingRect = p.mode === 'dragNode'
            ? (() => {
              const object = this.data.objects.find((entry) => entry.id === p.id)
              return object
                ? { id: object.id, x: rawPos.x, y: rawPos.y, width: object.size.width, height: object.size.height }
                : null
            })()
            : p.groupDrag
              ? { id: p.id, x: rawPos.x, y: rawPos.y, width: p.groupDrag.rect.w, height: p.groupDrag.rect.h }
              : null
          const correction = movingRect ? this.updateSmartGuides(movingRect) : { dx: 0, dy: 0 }
          const pos = { x: rawPos.x + correction.dx, y: rawPos.y + correction.dy }
          p.lastPos = pos
          if (p.mode === 'dragNode') this.callbacks.onObjectMove(p.id, pos)
          else if (p.groupDrag) {
            // 2D contract: members and nested stored groups ride along by the
            // drag delta, and so does the stored group position (groupPlatform.ts)
            const moves = groupDragMoves(p.id, p.groupDrag, pos)
            for (const [id, at] of moves.objects) this.callbacks.onObjectMove(id, at)
            for (const [id, at] of moves.groups) this.callbacks.onGroupMove(id, at)
          } else this.callbacks.onGroupMove(p.id, pos)
          break
        }
        case 'connEdit': {
          const edit = this.connEdit
          if (!edit) break
          const fp = this.floorPoint(e, this.connLayer.position.y)
          if (!fp) break
          const wp = { x: fp.x, y: fp.z }
          if (edit.mode === 'endpoint') {
            edit.preview = wp
            edit.hoverShapeId = this.pickClient(e.clientX, e.clientY, CONN_DROP_KINDS)?.target.id ?? null
          } else if (edit.mode === 'waypoint') {
            edit.working[edit.index] = wp
          } else if (edit.mode === 'pending') {
            // materialize the armed bend only after real movement (2D: 3 world units)
            if (Math.hypot(wp.x - edit.start.x, wp.y - edit.start.y) <= 3) break
            const conn = this.data.connections.find((c) => c.id === edit.connId)
            const working = (conn?.waypoints ?? []).map((w) => ({ ...w }))
            working.splice(edit.index, 0, wp)
            this.connEdit = { mode: 'waypoint', connId: edit.connId, index: edit.index, working }
            canvas.style.cursor = 'crosshair'
          } else {
            const geom = this.connGeoms.get(edit.connId)
            if (geom) {
              // project onto the path: t along it, clamped perpendicular offset
              const t = nearestTOnPath(geom, wp.x, wp.y)
              const pt = pathPoint(geom, t)
              const tan = pathTangent(geom, t)
              edit.t = t
              edit.offset = Math.max(-40, Math.min(40, (wp.x - pt.x) * -tan.y + (wp.y - pt.y) * tan.x))
            }
          }
          this.buildConnections()
          break
        }
      }
    })

    on('pointerup', (e) => {
      const p = this.pointer
      if (p.mode === 'dragVoxel') {
        const id = p.id
        const clicked = !p.moved
        p.mode = 'idle'
        p.id = null
        canvas.style.cursor = 'grab'
        if (id) {
          if (clicked) this.kickVoxel(id)
          else this.settleVoxel(id)
        }
        return
      }
      // connection-edit commit (2D parity: working state → one store write)
      if (p.mode === 'connEdit') {
        const edit = this.connEdit
        p.mode = 'idle'
        this.connEdit = null
        const buildsBefore = this.connLabelPerf.connBuilds
        if (edit && p.moved) {
          if (edit.mode === 'endpoint') {
            if (edit.preview && edit.hoverShapeId) {
              const rect = this.rectOf(edit.hoverShapeId)
              if (rect) {
                this.callbacks.onConnectionAnchorMove?.(
                  edit.connId,
                  edit.end,
                  edit.hoverShapeId,
                  nearestAnchorIndex(rect, edit.preview.x, edit.preview.y),
                )
              }
            }
          } else if (edit.mode === 'waypoint') {
            this.callbacks.onConnectionWaypointsChange?.(
              edit.connId,
              edit.working.map((w) => ({ ...w })),
            )
          } else if (edit.mode === 'label') {
            // the offset as DRAWN (a lit plate stays on its wire: the drag
            // clamps it to the nudge — connLabelPlacement), not the pointer's
            this.callbacks.onConnectionLabelMove?.(edit.connId, edit.t, this.connLabelOffsets.get(edit.connId)?.offset ?? edit.offset)
          }
          this.callbacks.onDragEnd?.()
        }
        // drop in-flight overrides; store echo re-syncs — unless the echo
        // already arrived inside the callbacks above (the store writes
        // synchronously, and its setData rebuilt the layer from the new data
        // with connEdit cleared): building the same data twice put two
        // connection builds and two label first-slices in the pointerup task
        // (connBuildMs 14-15 ms each on 0ob3fum, connect-freeze 2026-10-11)
        if (this.connLabelPerf.connBuilds === buildsBefore) this.buildConnections()
        return
      }
      const wasDrag = p.mode === 'dragNode' || p.mode === 'dragGroup'
      const wasNode = p.mode === 'dragNode'
      const wasCamera = p.mode === 'orbit' || p.mode === 'pan'
      const dragId = p.id
      const clicked = !p.moved
      // An orbit / pan moves the camera IMMEDIATELY (rig.orbitBy / panBy, no
      // tween), so the frameTick settle edge never fires for it: the camera
      // has settled when the pointer is released. Without this the LOD and
      // the connection labels' whole / abbreviated / hidden reading (TASK 2)
      // stayed those of the framing the orbit started from: with it removed,
      // a real-pointer orbit to polar 14 still read 4 whole / 6 hidden
      // (reports/view3d-quality/tp4-labels-mutB) against 9 / 1 with it
      // (tp4-labels-5, workbench).
      if (wasCamera && p.moved) this.updateNodeLod()
      p.mode = 'idle'
      p.id = null
      if (wasDrag && !clicked) {
        // Drop-snap to the half-grid (the 2D engine's gridSize 20 / 2 = 10):
        // the shape clips to the dot lattice exactly like the flat canvas.
        if (dragId && p.lastPos) {
          const snap = 10
          this.lastDropGuideSnap = { ...this.smartGuideSnap }
          const snapTo = (v: { x: number; y: number }) => ({
            x: this.smartGuideSnap.x ? v.x : Math.round(v.x / snap) * snap,
            y: this.smartGuideSnap.y ? v.y : Math.round(v.y / snap) * snap,
          })
          if (wasNode) this.callbacks.onObjectMove(dragId, snapTo(p.lastPos))
          else if (p.groupDrag) {
            // 2D drag-end: everything the drag moved snaps where it landed
            const moves = groupDragMoves(dragId, p.groupDrag, p.lastPos, snapTo)
            for (const [id, at] of moves.objects) this.callbacks.onObjectMove(id, at)
            for (const [id, at] of moves.groups) this.callbacks.onGroupMove(id, at)
          } else this.callbacks.onGroupMove(dragId, snapTo(p.lastPos))
        }
        this.callbacks.onDragEnd?.()
      }
      p.lastPos = null
      p.groupDrag = null
      this.clearSmartGuides(true)
      this.setGridDragging(false)
      if (!clicked) return
      // click semantics: select what was under the pointer, clear on background
      const hit = this.pick(e)
      if (!hit) {
        this.callbacks.onObjectSelect(null, false)
        return
      }
      switch (hit.target.kind) {
        case 'object':
          this.callbacks.onObjectSelect(hit.target.id, e.ctrlKey || e.metaKey || e.shiftKey)
          break
        case 'expand':
          // The corner expand glyph: a single click drills into the lower
          // level (the 2D tile button's contract). Falls back to select when
          // no drill host is wired.
          if (this.callbacks.onObjectOpen) this.callbacks.onObjectOpen(hit.target.id)
          else this.callbacks.onObjectSelect(hit.target.id, false)
          break
        case 'group':
          this.callbacks.onGroupSelect(hit.target.id)
          break
        case 'connection':
        case 'connLabel':
        case 'connEndpoint':
        case 'connWaypoint':
          this.callbacks.onConnectionSelect(hit.target.id)
          break
      }
    })

    on('pointercancel', () => {
      const p = this.pointer
      const wasPlacementDrag = p.mode === 'dragNode' || p.mode === 'dragGroup'
      p.mode = 'idle'
      p.id = null
      p.lastPos = null
      p.groupDrag = null
      this.clearSmartGuides(true)
      this.setGridDragging(false)
      if (wasPlacementDrag && p.moved) this.callbacks.onDragEnd?.()
      this.handleUniforms.uPressId.value = -1
      canvas.style.cursor = 'default'
    })

    on('wheel', (e) => {
      e.preventDefault()
      // wheel dolly never sets pointer.mode — hold the showcase drift explicitly
      if (this.showcase) this.showcaseHoldUntil = performance.now() + SHOWCASE_RESUME_MS
      this.rig.dollySmooth(Math.exp((e.deltaY / 100) * 0.18))
      // Dolly is immediate (no tween) so the settle-edge in frameTick never
      // fires — without this, labels hidden by the projected-size LOD stayed
      // hidden after wheel-zooming in until something else forced a rebuild
      // (text would only appear after clicking a shape).
      this.updateNodeLod()
    }, { passive: false })

    on('contextmenu', (e) => e.preventDefault())

    // the pointer left the board: no connection is hovered any more
    on('pointerleave', () => {
      this.setConnLabelHover(null)
      this.setHandleHover(null)
    })

    on('dblclick', (e) => {
      const hit = this.pick(e as unknown as PointerEvent)
      // double-click a bend dot removes that bend (2D behavior)
      if (hit && hit.target.kind === 'connWaypoint' && !this.readonly_) {
        const t = hit.target
        const conn = this.data.connections.find((c) => c.id === t.id)
        this.callbacks.onConnectionWaypointsChange?.(
          t.id,
          (conn?.waypoints ?? []).filter((_, i) => i !== t.index),
        )
        return
      }
      if (hit && hit.target.kind === 'object') {
        if (this.callbacks.onObjectOpen) {
          this.callbacks.onObjectOpen(hit.target.id)
          return
        }
        const o = this.data.objects.find((x) => x.id === hit.target.id)
        if (!o) return
        const pose = this.rig.getPose()
        this.rig.tweenTo({
          ...pose,
          targetX: o.position.x + o.size.width / 2,
          targetZ: o.position.y + o.size.height / 2,
          distance: pose.distance * 0.65,
        })
      }
    })
  }
}

// ── shared generated textures & ribbon builder ───────────────────────────────

const sharedTextures = new Map<string, THREE.CanvasTexture>()

/** Vertical two-stop gradient for the environment background (sRGB, cached). */
function gradientTexture(top: string, bottom: string): THREE.CanvasTexture {
  const key = `grad|${top}|${bottom}`
  const cached = sharedTextures.get(key)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, top)
  g.addColorStop(1, bottom)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 2, 256)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  sharedTextures.set(key, tex)
  return tex
}

/** Soft radial blob (white→transparent) used as alphaMap for every shadow. */
function blobTexture(): THREE.CanvasTexture {
  const cached = sharedTextures.get('blob')
  if (cached) return cached
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.5)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.65, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  sharedTextures.set('blob', tex)
  return tex
}

/** A comparable form of the label boxes the decor keeps off (0.01 px). */
function labelBoxesSig(boxes: readonly { x: number; y: number; w: number; h: number }[]): string {
  return boxes.map((b) => `${b.x.toFixed(2)},${b.y.toFixed(2)},${b.w.toFixed(2)},${b.h.toFixed(2)}`).join(';')
}

/** Arc length of a sampled route (world px). */
function pathLength(pts: readonly { x: number; y: number }[]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return total
}

/** Flat ribbon (y=0 strip) through `pts` with the given width; optional
 * [dash, gap] pattern measured along arc length. `withT` adds per-vertex
 * `aT` (normalized arc 0=source→1=target) and `aV` (cross-axis −1→+1)
 * attributes for the focus-flow band shaders. */
function buildRibbon(
  pts: { x: number; y: number }[],
  width: number,
  dash: [number, number] | null,
  withT = false,
): THREE.BufferGeometry | null {
  if (pts.length < 2) return null
  const hw = width / 2
  const positions: number[] = []
  const ts: number[] = []
  const av: number[] = []
  const indices: number[] = []
  let arc = 0
  let vi = 0
  let penDown = true
  const dashLen = dash ? dash[0] : 0
  const gapLen = dash ? dash[1] : 0
  let total = 0
  if (withT) for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)

  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)]
    const next = pts[Math.min(pts.length - 1, i + 1)]
    if (i > 0) arc += Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y)
    if (dash) {
      const phase = arc % (dashLen + gapLen)
      const nowDown = phase <= dashLen
      if (!nowDown) {
        penDown = false
        continue
      }
      if (!penDown) {
        // restart strip
        penDown = true
        vi = positions.length / 3
      }
    }
    let tx = next.x - prev.x
    let ty = next.y - prev.y
    const len = Math.hypot(tx, ty) || 1
    tx /= len
    ty /= len
    const nx = -ty * hw
    const ny = tx * hw
    positions.push(pts[i].x + nx, 0, pts[i].y + ny, pts[i].x - nx, 0, pts[i].y - ny)
    if (withT) {
      const t = total > 0 ? arc / total : 0
      ts.push(t, t)
      av.push(1, -1) // matches the +n / −n vertex order above
    }
    const base = positions.length / 3 - 2
    if (base >= vi + 2) {
      indices.push(base - 2, base - 1, base, base - 1, base + 1, base)
    }
  }
  if (positions.length < 12) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  if (withT) {
    geo.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(ts), 1))
    geo.setAttribute('aV', new THREE.BufferAttribute(new Float32Array(av), 1))
  }
  geo.setIndex(indices)
  return geo
}
