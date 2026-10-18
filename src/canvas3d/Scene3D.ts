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
import { cableProfileFor, cableYAt, type CableProfile } from './cableProfile'
import type { Scene3dDecorInfo, Scene3dDisposeResidue, Scene3dProbe, Scene3dSceneStats } from './scene3dProbe'
import {
  CameraRig,
  designEase,
  poseFor2dViewport,
  viewportForPose,
  type CameraPose,
  type CameraViewportInsets,
} from './camera'
import {
  colorAlpha,
  drumFaceColor,
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
  ANCHOR_COUNT,
  anchorPoint,
  connectionPath,
  edgePoint,
  endpointDragPreview,
  nearestAnchorIndex,
  nearestSegmentIndex,
  nearestTOnPath,
  pathPoint,
  pathTangent,
  samplePath,
  type EdgePoint,
  type Face,
  type PathGeometry,
  type Rect,
} from './connectionPath'
import type { Environment3D, FloorSpec3D, NodeSpec3D, Theme3dSource } from './specs'
import type { SceneDecor3D } from './decor/decorSpec'
import { placeDecor } from './decor/placement'
import { DESK_ARCHETYPES, getDecorPack } from './decor/registry'
import { buildDecorMeshes, disposeDecorBuild, disposeDecorGeometries, type DecorBuildResult } from './decor/build'
import {
  acquireRoomEnvironment,
  disposeLightRig,
  fitShadowCamera,
  mountLightRig,
  releaseRoomEnvironment,
  type LightRig,
} from './lit/lighting'
import { litSurface } from './lit/materials'
import type { PostStack, QualityTier } from './lit/post'
import { paperBoardTextures } from './lit/paper'
import { trayTexturesFor, type TrayVariant } from './lit/boards'
import { workbenchTextures } from './lit/wood'
import { buildCityBackground, buildDeskLamp, buildStudioBackground, type MakeMat } from './decor/backgrounds'
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { disposeThemeAssets, getLoadedAsset, loadThemeAsset } from './assets'
import { getActiveScene3D, setActiveScene3D } from './activeScene'

// ── DS card anatomy (design-system C4 node card / editor-3d kit) ─────────────
const CARD_RADIUS = 14
const CARD_PAD_X = 15
const CARD_PAD_Y = 13
const NAME_SIZE = 13
const SUB_SIZE = 10.5
const PILL_SIZE = 10
const PILL_H = 16
const PILL_RADIUS = 6
// standee drum (kit CylStandee)
const DRUM_R = 46
const DRUM_H = 64
const PAD_R = 59

/** Kit text-width heuristic (Editor3DApp uses `len * 6.2 + 14` at 10.5px). */
const approxTextWidth = (text: string, fontSize: number) => text.length * fontSize * 0.59

// ── Projected-size LOD (the draw-call/text mitigation at scale) ─────────────
// A node's readable decorations hide once its on-screen width shrinks past
// readability, so a fit-all of hundreds of nodes doesn't pay for sub-pixel text
// and tiles nobody can read. Decorations tag themselves via `userData.lod`; the
// pickable fill plate, slab and shadow are NEVER tagged (they define the card).
const LOD_SECONDARY = 1 // subtitle, tech pills, accent bar — first to hide
const LOD_PRIMARY = 2 // name, type tile, glyph, icon — kept until very small
const LOD_SECONDARY_PX = 140 // card projected width (css px) below which tier-1 hides
const LOD_PRIMARY_PX = 84 // …below which tier-2 hides too (a bare colored slab)

// Showcase mode (viewer/embeds): slow presentation auto-orbit — a full
// turn every 60s — pausing on any interaction and resuming after a beat.
const SHOWCASE_DEG_PER_S = 6
const SHOWCASE_RESUME_MS = 2500

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
  private litFloorGrid: { mat: THREE.MeshPhysicalMaterial; on: THREE.Texture; off: THREE.Texture } | null = null
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
  /** Per-build cable anatomy facts (lit profile) — read by the cableInfo()
   * dev probe so e2e can assert every plug lands INSIDE its node's wall and
   * the run rests ABOVE its support (no cable ends floating beside the shapes,
   * no mid-span sinking into group platforms). */
  private cableDebug: CableDebugEntry[] = []

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
    groupDrag: {
      rect: { x: number; y: number; w: number; h: number }
      groupPos: { x: number; y: number } | null
      members: Map<string, { x: number; y: number }>
    } | null
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
  /** The lit post stack (own lazy chunk; null = composer-less render). */
  private post: PostStack | null = null
  private postLoading = false
  /** Auto-degrade bookkeeping (lit frames only): EMA of renderFrame cost. */
  private frameCostEma = 0
  private slowFrames = 0

  // ── scene decoration (per-diagram shared setting — decor track) ────────────
  private sceneDecor: SceneDecor3D | null = null
  /** Background world actually built by the last buildFloor (probe/e2e). */
  private bgWorldBuilt: 'workbench' | 'city' | 'studio' | 'void' | null = null
  private decorBuild: DecorBuildResult | null = null
  private decorRefreshTimer: ReturnType<typeof setTimeout> | null = null
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
    this.rig = new CameraRig(() => this.requestRender())
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
    // compiler checks the key as well as the shape (through a
    // `Record<string, unknown>` cast, any key at all would typecheck).
    if (import.meta.env.DEV) {
      window.__scene3d = {
        getPose: () => this.rig.getPose(),
        isCameraAnimating: () => this.rig.isAnimating(),
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
            bgIsGradient: this.scene.background instanceof THREE.Texture,
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
            if ((o as THREE.Light).isLight) lightsCount++
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
        /** Debug/e2e: lit cable anatomy — every plug must land INSIDE its
         * node's wall span and the run must rest ABOVE the higher support.
         * Empty under the unlit profile. */
        cableInfo: () => this.cableDebug.map((c) => ({ ...c, from: { ...c.from }, to: { ...c.to } })),
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
        /** Debug/probe: the background world's fabric manifest (walk-up /
         * cornice / roof-treatment counts for the Montréal city ring). */
        cityFabricInfo: () => {
          let found: unknown = null
          this.root.traverse((o) => {
            if (o.userData.cityFabric) found = o.userData.cityFabric
          })
          return found
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
            : null,
          phase: this.flowUnits[0]?.lastT ?? null,
        }),
        /** Debug/e2e: the grid toggle + whether the floor dots currently show. */
        gridInfo: () => ({
          showGrid: this.showGrid,
          dotsVisible: this.floorGridToggle
            ? !this.floorGridToggle.uniform.value.equals(this.floorGridToggle.off)
            : this.litFloorGrid
              ? this.litFloorGrid.mat.map === this.litFloorGrid.on
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
          return {
            from: { x: geom.fromEdge.x, y: geom.fromEdge.y },
            to: { x: geom.toEdge.x, y: geom.toEdge.y },
            mid: pathPoint(geom, 0.5),
            label: conn.label ? { x: pt.x - tan.y * off, y: pt.y + tan.x * off } : null,
            waypoints: (conn.waypoints ?? []).map((w) => ({ ...w })),
            planeY: this.connLayer.position.y,
          }
        },
        // `satisfies`, not a cast (see `scene3dProbe.ts`): `npm run build` is
        // the comparison — a member added here without being declared there is
        // an excess-property error, a member declared there and not installed
        // here is a missing-property error. It is not redundant with the typed
        // target: it names the contract where the literal is edited, and it is
        // what USES the `import type` above, which keeps `scene3dProbe.ts` (and
        // its global augmentation) in this program. Drop the import and
        // `window.__scene3d` stops existing here (TS2339).
      } satisfies Scene3dProbe
      this.devProbeIdentity = window.__scene3d
    }
  }

  // ── host API ───────────────────────────────────────────────────────────────

  setSize(width: number, height: number): void {
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
    if (this.post) {
      const t0 = performance.now()
      this.post.render()
      // Auto-degrade governor: sustained slow lit frames walk the tier down
      // (high → medium → low), never back up — a stutter on entry is fine, a
      // permanently sluggish board is not.
      const cost = performance.now() - t0
      this.frameCostEma = this.frameCostEma === 0 ? cost : this.frameCostEma * 0.9 + cost * 0.1
      if (this.frameCostEma > 26) {
        if (++this.slowFrames >= 60) {
          this.slowFrames = 0
          this.frameCostEma = 0
          this.setQualityTier(this.qualityTier === 'high' ? 'medium' : 'low')
        }
      } else {
        this.slowFrames = 0
      }
      return
    }
    this.renderer.render(this.scene, this.rig.camera)
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
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
      this.litRig = mountLightRig(this.scene, this.litRig, lighting)
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
        this.scene.environment = null
      }
      if (!this.litEnvHeld) {
        this.scene.environment = acquireRoomEnvironment(this.renderer)
        this.litEnvHeld = true
      }
      this.scene.environmentIntensity = lighting.ibl?.intensity ?? 0.35
      this.renderProfile = 'lit'
      this.ensurePost()
    } else {
      this.renderer.toneMapping = THREE.NoToneMapping
      this.renderer.toneMappingExposure = 1
      this.renderer.shadowMap.enabled = false
      disposeLightRig(this.scene, this.litRig)
      this.litRig = null
      if (this.litEnvHeld) {
        releaseRoomEnvironment(this.renderer)
        this.litEnvHeld = false
      }
      this.scene.environment = null
      this.scene.environmentIntensity = 1
      this.renderProfile = 'unlit'
      this.disposePost()
      this.qualityTier = 'high'
    }
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
        const size = this.renderer.getSize(new THREE.Vector2())
        this.post = m.createPostStack(this.renderer, this.scene, this.rig.camera, lit, this.qualityTier as Exclude<QualityTier, 'low'>)
        this.post.setSize(size.x, size.y)
        this.composerPassCount = this.post.passCount
        this.requestRender()
      })
      .catch(() => {
        // chunk load failure (offline dev, CSP): stay composer-less — the lit
        // scene is still fully usable, AO/bloom are enhancement layers
        this.postLoading = false
      })
  }

  private disposePost(): void {
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
        this.scene.background = gradientTexture(env.background.top, env.background.bottom)
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
    this.rebuild()
  }

  setShowGrid(show: boolean): void {
    if (show === this.showGrid) return
    this.showGrid = show
    const t = this.floorGridToggle
    if (t) t.uniform.value = show ? t.on : t.off
    const lg = this.litFloorGrid
    if (lg) {
      lg.mat.map = show ? lg.on : lg.off
      lg.mat.needsUpdate = false // same program — just a texture ref swap
    }
    this.requestRender()
  }

  setSelection(ids: string[]): void {
    const next = new Set(ids)
    if (next.size === this.selectedIds.size && [...next].every((id) => this.selectedIds.has(id))) return
    this.selectedIds = next
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
    else if (insets) this.rig.goToPresetWithInsets(this.preset, this.contentBounds(), insets, false)
    else this.rig.goToPreset(this.preset, this.contentBounds(), false)
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
    const target = this.rig.presetPoseFor(this.preset, this.contentBounds())
    const start =
      view2d && css
        ? poseFor2dViewport(view2d, css, target.fov)
        : { ...target, polar: 1, azimuth: 0, distance: target.distance * 1.06 }
    this.lastEnterStart = { ...start }
    this.rig.setPose(start)
    this.floorAlpha = 0
    this.applyFloorAlpha()
    this.rig.tweenTo(target)
    this.startFloorFade(1)
  }

  /** Exit choreography: compute the 2D viewport the current camera hands
   * back (framing identity at the css centre), reverse-tween to its top-down
   * pose while the floor dressing fades out. Returns the handoff viewport so
   * the host can pre-set the flat canvas beneath the crossfade; `onDone` fires
   * when the camera lands (immediately under reduced motion; dropped if the
   * tween is interrupted — hosts keep a fallback timer). */
  exitMorph(css: { width: number; height: number }, onDone: () => void): { x: number; y: number; scale: number } {
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
    if (this.showcaseResumeTimer !== null) {
      clearTimeout(this.showcaseResumeTimer)
      this.showcaseResumeTimer = null
    }
    for (const fn of this.detachFns) fn()
    this.clearSmartGuides(true)
    this.smartGuideLayer.removeFromParent()
    this.clearRoot()
    this.voxelTransient.clear()
    disposeIconTextures()
    disposeThemeAssets()
    this.floorMapClone?.clone.dispose()
    this.floorMapClone = null
    for (const [, tex] of sharedTextures) tex.dispose()
    sharedTextures.clear()
    if (this.decorRefreshTimer !== null) {
      clearTimeout(this.decorRefreshTimer)
      this.decorRefreshTimer = null
    }
    disposeDecorGeometries()
    // Lit-profile resources live OUTSIDE root (clearRoot never sees them).
    this.disposePost()
    disposeLightRig(this.scene, this.litRig)
    this.litRig = null
    if (this.litEnvHeld) {
      releaseRoomEnvironment(this.renderer)
      this.litEnvHeld = false
      this.scene.environment = null
    }
    // Dispose-residue accounting (leak gate): after every disposal above,
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
    if (import.meta.env.DEV) {
      if (window.__scene3d === this.devProbeIdentity) delete window.__scene3d
      this.devProbeIdentity = null
    }
  }

  // ── render loop (on demand) ────────────────────────────────────────────────

  requestRender(): void {
    if (this.disposed) return
    this.needsRender = true
    if (!this.raf) this.raf = requestAnimationFrame(this.frameTick)
  }

  private frameTick = (now: number) => {
    this.raf = 0
    if (this.disposed) return
    // Context lost: skip the frame entirely. `needsRender` stays latched; the
    // restore handler's rebuild() re-kicks the loop once the context is back.
    if (this.contextLost) return
    const animating = this.rig.step(now)
    // Camera just settled → the projected sizes are final; re-evaluate LOD once.
    if (this.wasAnimating && !animating) this.updateNodeLod()
    this.wasAnimating = animating
    const fading = this.stepFloorFade(now)
    const moving = this.stepMotion(now)
    const voxeling = this.stepVoxelFragments(now)
    const flowing = this.stepFlow(now)
    const spinning = this.stepShowcase(now, animating)
    if (this.needsRender || animating || fading || moving || voxeling || flowing || spinning) {
      this.needsRender = false
      // billboard theme assets stay camera-facing through every orbit
      for (const b of this.billboards) b.quaternion.copy(this.rig.camera.quaternion)
      this.renderFrame()
    }
    if (animating || fading || moving || voxeling || flowing || spinning) this.requestRender()
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

  private groupRect(g: Group): Rect {
    // 2D computeGroupBounds contract: a parent wrapper always hugs its members;
    // a standalone group honors stored geometry only when autoSize is OFF. Any
    // other group derives its box from member positions, so moving a member
    // re-hugs the platform live ("autolayout").
    const isParentWrapper = !!g.parentObjectId
    const stored =
      g.position && g.size
        ? { x: g.position.x, y: g.position.y, w: g.size.width, h: g.size.height }
        : null
    if (g.autoSize === false && stored && !isParentWrapper) return stored
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const id of g.objectIds) {
      const o = this.data.objects.find((x) => x.id === id)
      if (!o) continue
      minX = Math.min(minX, o.position.x)
      minY = Math.min(minY, o.position.y)
      maxX = Math.max(maxX, o.position.x + o.size.width)
      maxY = Math.max(maxY, o.position.y + o.size.height)
    }
    if (!isFinite(minX)) {
      // no members on this diagram: stored geometry, else the 2D default
      // 240x160 drop-target box at the group's position (or the origin)
      if (stored) return stored
      const pos = g.position ?? { x: 0, y: 0 }
      return { x: pos.x, y: pos.y, w: g.size?.width ?? 240, h: g.size?.height ?? 160 }
    }
    return { x: minX - 30, y: minY - 46, w: maxX - minX + 60, h: maxY - minY + 76 }
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
  private rebuild(): void {
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
          }
        }
      }
      this.buildConnections()
      this.scheduleDecorRefresh()
      this.requestRender()
      return
    }
    this.buildSignature = sig
    this.clearRoot()
    this.refreshTagFocusMembership()

    const preset = CAMERA_PRESETS[this.preset]
    const memberOf = new Map<string, Group>()
    for (const g of this.data.groups) for (const id of g.objectIds) memberOf.set(id, g)

    this.buildFloor()
    for (const g of this.data.groups) this.buildPlatform(g, preset.plat)
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
    this.buildConnections()
    this.buildDecor()
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
        fitShadowCamera(
          this.litRig,
          { x: bb.cx - bb.width / 2, y: bb.cz - bb.height / 2, width: bb.width, height: bb.height },
          {
            enabled: this.renderProfile === 'lit' && lighting.shadows?.enabled !== false,
            mapSize: lighting.shadows?.mapSize,
            intensity: dusk ? Math.min(0.8, (lighting.shadows?.opacity ?? 0.55) + 0.09) : lighting.shadows?.opacity,
          },
        )
      }
    }
    this.updateNodeLod() // apply the projected-size LOD to the freshly built nodes
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
      if (this.decorBuild.group.visible !== visible) this.decorBuild.group.visible = visible
    }
    let changed = false
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
        }
      }
    }
    if (changed) this.requestRender()
  }

  private clearRoot(): void {
    this.root.traverse((obj) => {
      if (obj.userData.sharedAsset) {
        // Geometry stays cache-owned. A dimmed instance may own a lightweight
        // material clone so changing its opacity never affects sibling assets.
        if (obj.userData.tagPerspectiveMaterialClone) {
          const material = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
          if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
          else material?.dispose()
        }
        return
      }
      const mesh = obj as THREE.Mesh
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose()
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else if (mat) mat.dispose()
    })
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
      disposeDecorBuild(this.decorBuild)
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
      if (mesh.geometry) mesh.geometry.dispose()
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
    opts: { side?: THREE.Side; depthWrite?: boolean; vertexColors?: boolean } = {},
  ): THREE.Material {
    const lighting = this.renderProfile === 'lit' ? this.theme3d?.environment?.lighting : null
    if (lighting) return litSurface(role, css, opts, lighting)
    return this.unlit(css, opts)
  }

  private unlit(css: string, opts: { side?: THREE.Side; depthWrite?: boolean; vertexColors?: boolean } = {}): THREE.MeshBasicMaterial {
    const { color, alpha } = colorAlpha(css)
    return new THREE.MeshBasicMaterial({
      color,
      transparent: alpha < 1,
      opacity: alpha,
      side: opts.side ?? THREE.FrontSide,
      depthWrite: opts.depthWrite ?? alpha >= 1,
      vertexColors: opts.vertexColors ?? false,
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
      return new THREE.Mesh(geo, [capMaterial, sideMaterial])
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
  private buildDecor(): void {
    if (this.decorBuild) {
      this.root.remove(this.decorBuild.group)
      disposeDecorBuild(this.decorBuild)
      this.decorBuild = null
    }
    const decor = this.sceneDecor
    if (!decor) return
    const pack = getDecorPack(decor.packId)
    if (!pack) return
    const lit = this.renderProfile === 'lit'
    // the shared WORKBENCH props ride along on lit themes (the wood desk
    // plane exists there); unlit boards keep pack-only decor
    const archetypes = lit ? [...pack.archetypes, ...DESK_ARCHETYPES] : pack.archetypes
    const b = this.contentBounds()
    const placed = placeDecor({
      archetypes,
      density: decor.density ?? 'normal',
      seed: decor.seed ?? 1,
      bounds: { x: b.cx - b.width / 2, y: b.cz - b.height / 2, w: b.width, h: b.height },
      pad: this.lastFloorPad,
      fractureBand: this.lastFractureBand,
      nodes: this.data.objects.map((o) => ({ id: o.id, type: o.type, rect: this.objectRect(o) })),
      groups: this.data.groups.map((g) => this.groupRect(g)),
      connections: [...this.connGeoms.values()].map((geom) => ({ points: samplePath(geom, 12) })),
      deskBand: lit ? 150 : undefined,
    })
    const build = buildDecorMeshes({ ...pack, archetypes }, placed, {
      lit,
      platformLift: CAMERA_PRESETS[this.preset].plat,
      // desk level: the workbench plane sits 16 px under the slab bottom
      deskLift: -(CAMERA_PRESETS[this.preset].floorD + 16) + 0.3,
    })
    // decor rides the 2D↔3D morph exactly like the board dressing
    for (const m of build.materials) this.regFloorFade(m, 1)
    this.decorBuild = build
    this.root.add(build.group)
    this.applyFloorAlpha()
  }

  /** Fast-path node drags reposition WITHOUT a rebuild (dataSignature skips
   * positions) — refresh the decor shortly after the last move so props
   * clear the moved card. Cell-hashed placement keeps far props identical. */
  private scheduleDecorRefresh(): void {
    if (!this.sceneDecor) return
    if (this.decorRefreshTimer !== null) clearTimeout(this.decorRefreshTimer)
    this.decorRefreshTimer = setTimeout(() => {
      this.decorRefreshTimer = null
      if (this.disposed) return
      this.buildDecor()
      this.requestRender()
    }, 300)
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

  private buildFloor(): void {
    this.bgWorldBuilt = null
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
        pairOn = trayTexturesFor(tray, { grid: look.grid, showGrid: fs?.grid !== 'none' })
        pairOff = trayTexturesFor(tray, { grid: look.grid, showGrid: false })
        capRough = 1 // tray roughnessMaps encode absolute bands (boards.ts)
        capEnv = look.env
        wallCss = look.wall
        if (look.fill) pal.platformFill = look.fill
      } else {
        const baseCss = colorAlpha(palette.floorBg).color
        const gridCol = colorAlpha(gridCss).color
        pairOn = paperBoardTextures({ base: baseCss, grid: gridCol, showGrid: fs?.grid !== 'none' })
        pairOff = paperBoardTextures({ base: baseCss, grid: gridCol, showGrid: false })
      }
      const active = this.showGrid ? pairOn : pairOff
      const cap = new THREE.MeshPhysicalMaterial({
        map: active.map,
        roughnessMap: active.roughnessMap,
        roughness: capRough,
        metalness: 0,
        envMapIntensity: capEnv,
      })
      this.litFloorGrid = { mat: cap, on: pairOn.map, off: pairOff.map }
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
    // brass practical lamp. 'city': the low-poly maquette ring on the desk
    // around the board. 'studio': desk + warm cyclorama sweep. 'void': bare
    // gradient void — board and props only. The desk plane keeps its long
    // grain + plank seams + board-centered vignette and receives the
    // key-light shadow; the SDF ground shadow draws above it.
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
      if (world !== 'void') {
        const deskSize = Math.max(6000, Math.max(w, h) * 6)
        const wood = workbenchTextures('#C8A67D')
        const deskMat = new THREE.MeshStandardMaterial({
          map: wood.map,
          roughnessMap: wood.roughnessMap,
          roughness: 1,
          metalness: 0,
        })
        this.regFloorFade(deskMat, 1)
        const desk = new THREE.Mesh(new THREE.PlaneGeometry(deskSize, deskSize), deskMat)
        desk.rotation.x = -Math.PI / 2
        desk.position.set(fractureBand + slabW / 2, deskY, fractureBand + slabH / 2)
        desk.receiveShadow = true
        desk.renderOrder = -12 // under the SDF board shadow (-11) and the slab (-10)
        floor.add(desk)
      }
      if (world === 'city') {
        // seed rides the decor seed (resolveSceneDecor defaults it from the
        // diagram id), so two diagrams never share a skyline
        // hole apron kept TIGHT (+35 a side): with the builder's street
        // margin the first low blocks stand ~half a card-width off the board
        // edge — a wider apron leaves a barren desk band that isolates the
        // board from its city.
        const city = buildCityBackground({
          hole: { x: fractureBand + slabW / 2, z: fractureBand + slabH / 2, w: slabW + 70, h: slabH + 70 },
          radius: Math.max(1800, Math.max(slabW, slabH) * 2.75),
          baseY: deskY,
          seed: (this.sceneDecor?.seed ?? 1) >>> 0,
          makeMat,
        })
        floor.add(city.group)
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
        const lamp = buildDeskLamp({
          // parked past the board's TOP edge, near centre — the iso camera
          // (azimuth 40°) maps +x/−z to screen-right, so anchors further
          // right project past the default crop or sink the base behind the
          // right panel, and anchors further up behead the dome. 0.46·slabW
          // keeps it off the panel; −35 sits at the slab lip (base disc ~8
          // units clear). The builder's gooseneck hunches the dome LOW over
          // the desk (backgrounds.ts) because a straight mast cannot fit
          // between the top toolbar and the board edge — the lamp must be in
          // shot pouring its pool, not an off-stage glow.
          position: [fractureBand + slabW * 0.46, deskY, fractureBand - 35],
          // scaled UNDER 1 so the brass dome clears the frame-top ray: at
          // full size only the stand entered the crop and the dome — the
          // golden-key icon itself — stays beheaded above the frame
          // (down-screen is (+x,+z) here, and more +z would park the base ON
          // the board).
          scale: 0.5,
          // shade + spot aim DOWN-LEFT onto the open paper just below the
          // top edge (the corner lamp pours across the cards, not at them).
          // A centre aim floods the whole slab (clipping to 255 across most
          // of it); an aim on the
          // upper-right card blows its top to pure white. The short aim
          // keeps incidence ~48°, bounds the pool by mid-board, and its
          // south spill exits over the board's left edge.
          boardCenter: [fractureBand + slabW * 0.42, 0, fractureBand + slabH * 0.18],
          makeMat,
        })
        floor.add(lamp.group)
        if (lamp.lamp) {
          // decay 0: a predictable warm accent pool, not a physical falloff —
          // the key light owns shadows, the practical stays shadowless.
          // Intensity/angle are engine-owned (the spec's 2.4/0.5 vanishes
          // under the studio sun + ACES). The sun/hemi are kept low
          // (studioSkin) to open headroom and the spot owns the top of the
          // range: measured ~250+ in the pool centre vs ~190 open paper at
          // board bottom-left (a ~+30 % golden-key gradient), cards still
          // unclipped.
          // the wood tray's albedo swallows the pool that reads on paper:
          // the practical pushes harder + tighter there
          const woodTray = this.trayStyle() === 'wood'
          // with the fill at 0.48 the pool must own the top of the exposure
          // range on every tray
          const spot = new THREE.SpotLight(
            new THREE.Color(lamp.lamp.color),
            woodTray ? 6.2 : 4.6,
            0,
            woodTray ? 0.4 : 0.43,
            lamp.lamp.penumbra,
            0,
          )
          spot.position.set(...lamp.lamp.position)
          const target = new THREE.Object3D()
          target.position.set(...lamp.lamp.target)
          spot.target = target
          spot.castShadow = false
          floor.add(spot, target)
        }
      }
    }

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
      shadow.position.set(fractureBand + slabW / 2 + 24, -floorD - 14, fractureBand + slabH / 2 + 36)
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
      // frosted walls. Height 2.6 stays under every cable plug (plugY ≥
      // wallBase + 4.2 — cable anatomy invariant), so the plug boots keep
      // biting the glass wall, never the wood.
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
      const subText = this.addText({
        text: fittedDescription.lines.join('\n'),
        font: 'inter400',
        size: fittedDescription.fontSize,
        color: colorAlpha(external ? objSkin.descriptionExternal : objSkin.description).color,
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
      color: objSkin.badgeText,
      anchorX: 'center',
      anchorY: 'middle',
    })
    pillText.userData.cardContentRole = 'typeBadgeText'
    pillText.userData.cardContentAnchor = { x: content.centerX, z: content.typeBadgeTopY + PILL_H / 2 }
    pillText.userData.lod = LOD_SECONDARY
    pillText.position.set(content.centerX, z + 0.1, content.typeBadgeTopY + PILL_H / 2 + 0.5)
    unit.add(pillText)

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
    // the tinted first-letter plate.
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
      badge.userData.lod = LOD_PRIMARY
      badge.position.set(cx, baseY + lift + DRUM_H / 2, cz + DRUM_R + 1.2)
      unit.add(badge)
    }

    // name tag on the pad front (kit ed3c3__tag)
    const tagW = approxTextWidth(o.name, SUB_SIZE) + 18
    const tag = this.plate(tagW, 18, this.pxr(7), this.surface('tagPlate', palette.tagBg))
    tag.userData.lod = LOD_PRIMARY
    tag.position.set(cx - tagW / 2, baseY + 0.4, cz + 49)
    unit.add(tag)
    const tagBorder = this.ringPlate(tagW, 18, this.pxr(7), 1, this.surface('padRing', palette.padBorder, { depthWrite: false }))
    tagBorder.userData.lod = LOD_PRIMARY
    tagBorder.position.set(cx - tagW / 2, baseY + 0.5, cz + 49)
    unit.add(tagBorder)
    const tagText = this.addText({
      text: o.name,
      font: 'inter600',
      size: SUB_SIZE,
      color: colorAlpha(palette.tagText).color,
      anchorX: 'center',
      anchorY: 'middle',
    })
    tagText.userData.lod = LOD_PRIMARY
    tagText.position.set(cx, baseY + 0.6, cz + 49 + 9.5)
    unit.add(tagText)

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

  /** Final plug POINTS for every lit solid connection (so a corner arrival
   * never ends in the air and neighbouring boots never merge). Each
   * un-trimmed endpoint clamps onto the FLAT stretch of its wall — out of
   * the rounded corners — and same-wall neighbours relax to PLUG_PITCH.
   * Deterministic: buckets sort by (natural coord, connId:end). Drum ends
   * slot by ANGLE on the cylinder. Keyed `${connId}:${'from'|'to'}`. */
  private computePlugSlots(
    rects: Map<string, Rect>,
    objectById: Map<string, C4Object>,
  ): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>()
    interface WallSlot { key: string; rect: Rect; face: Face; coord: number }
    const walls = new Map<string, WallSlot[]>()
    const drums = new Map<string, { key: string; cx: number; cz: number; angle: number }[]>()
    for (const conn of this.data.connections) {
      if (conn.type === 'dashed' || conn.type === 'dotted') continue
      const fromRect = rects.get(conn.fromId)
      const toRect = rects.get(conn.toId)
      if (!fromRect || !toRect) continue
      const locked = conn.lockedToAnchors === true
      const fromEdge = locked && conn.fromAnchor !== undefined
        ? anchorPoint(fromRect, conn.fromAnchor)
        : edgePoint(fromRect, toRect.x + toRect.w / 2, toRect.y + toRect.h / 2)
      const toEdge = locked && conn.toAnchor !== undefined
        ? anchorPoint(toRect, conn.toAnchor)
        : edgePoint(toRect, fromRect.x + fromRect.w / 2, fromRect.y + fromRect.h / 2)
      const ends: [string, string, Rect, EdgePoint][] = [
        [`${conn.id}:from`, conn.fromId, fromRect, fromEdge],
        [`${conn.id}:to`, conn.toId, toRect, toEdge],
      ]
      for (const [key, nodeId, rect, edge] of ends) {
        if (objectById.get(nodeId)?.type === 'store') {
          const cx = rect.x + rect.w / 2
          const cz = rect.y + rect.h / 2
          const list = drums.get(nodeId) ?? []
          list.push({ key, cx, cz, angle: Math.atan2(edge.y - cz, edge.x - cx) })
          drums.set(nodeId, list)
        } else {
          const wallKey = `${nodeId}:${edge.face}`
          const list = walls.get(wallKey) ?? []
          list.push({ key, rect, face: edge.face, coord: edge.face === 'left' || edge.face === 'right' ? edge.y : edge.x })
          walls.set(wallKey, list)
        }
      }
    }
    // 1D relaxation to PLUG_PITCH inside [lo, hi]; a wall too short for the
    // pitch distributes evenly instead
    const relax = (coords: number[], lo: number, hi: number): number[] => {
      const n = coords.length
      if (n === 0) return coords
      if (hi <= lo) return coords.map(() => (lo + hi) / 2)
      if (hi - lo <= PLUG_PITCH * (n - 1)) {
        return coords.map((_, i) => (n === 1 ? (lo + hi) / 2 : lo + ((hi - lo) * i) / (n - 1)))
      }
      const spread = coords.map((c) => Math.min(Math.max(c, lo), hi))
      for (let i = 1; i < n; i++) spread[i] = Math.max(spread[i], spread[i - 1] + PLUG_PITCH)
      spread[n - 1] = Math.min(spread[n - 1], hi)
      for (let i = n - 2; i >= 0; i--) spread[i] = Math.min(spread[i], spread[i + 1] - PLUG_PITCH)
      return spread
    }
    for (const list of walls.values()) {
      list.sort((a, b) => a.coord - b.coord || (a.key < b.key ? -1 : 1))
      const r0 = list[0].rect
      const horizontal = list[0].face === 'top' || list[0].face === 'bottom'
      const lo = (horizontal ? r0.x : r0.y) + PLUG_CORNER_MARGIN
      const hi = (horizontal ? r0.x + r0.w : r0.y + r0.h) - PLUG_CORNER_MARGIN
      const coords = relax(list.map((s) => s.coord), lo, hi)
      list.forEach((s, i) => {
        const c = coords[i]
        out.set(
          s.key,
          s.face === 'left'
            ? { x: s.rect.x, y: c }
            : s.face === 'right'
              ? { x: s.rect.x + s.rect.w, y: c }
              : s.face === 'top'
                ? { x: c, y: s.rect.y }
                : { x: c, y: s.rect.y + s.rect.h },
        )
      })
    }
    for (const list of drums.values()) {
      list.sort((a, b) => a.angle - b.angle || (a.key < b.key ? -1 : 1))
      const pitch = PLUG_PITCH / (DRUM_R - 1.5)
      const angles = list.map((s) => s.angle)
      for (let i = 1; i < angles.length; i++) angles[i] = Math.max(angles[i], angles[i - 1] + pitch)
      list.forEach((s, i) => {
        out.set(s.key, {
          x: s.cx + Math.cos(angles[i]) * (DRUM_R - 1.5),
          y: s.cz + Math.sin(angles[i]) * (DRUM_R - 1.5),
        })
      })
    }
    return out
  }

  /** Wall + plug facts for one cable end (world heights). Cards plug into
   * the slab wall, drums into the cylinder (with an XZ snap target), group
   * ends into the platform pedestal. The plug sits low on the wall (the
   * reference image's ports live near the bench), clamped so the boot
   * (radius·1.9 ≈ ≤5.5 world px) stays on porcelain even on thin walls. */
  private cableEndpointFacts(
    id: string,
    obj: C4Object | undefined,
    rect: Rect,
    isGroup: boolean,
  ): { wallBase: number; wallTop: number; plugY: number; snapCenter: { x: number; z: number } | null } {
    const preset = CAMERA_PRESETS[this.preset]
    const wallBase = this.nodeGroups.get(id)?.userData.baseY ?? 0
    const isDrum = obj?.type === 'store'
    const wallTop = isGroup ? preset.plat : isDrum ? wallBase + DRUM_H : wallBase + preset.depth
    const raw = wallBase + Math.min(Math.max((wallTop - wallBase) * 0.42, 4.2), 12)
    const plugY = Math.min(raw, Math.max(wallBase + 2.2, wallTop - 4.2))
    return {
      wallBase,
      wallTop,
      plugY,
      snapCenter: isDrum ? { x: rect.x + rect.w / 2, z: rect.y + rect.h / 2 } : null,
    }
  }

  private buildConnections(): void {
    const skin = this.skin
    if (!skin) return
    // reset layer (troika texts dispose through their own API, not traverse)
    const connTextSet = new Set<THREE.Object3D>(this.connTexts)
    this.connLayer.traverse((obj) => {
      if (connTextSet.has(obj)) return
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else if (mat) mat.dispose()
    })
    for (const t of this.connTexts) t.dispose()
    this.connTexts = []
    this.connLayer.clear()
    this.pickables = this.pickables.filter(
      (p) => !CONN_PICK_KINDS.has((p.userData.pick as PickTarget | undefined)?.kind as PickTarget['kind']),
    )
    this.connGeoms.clear()
    this.cableDebug = []
    this.flowUnits = [] // meshes were in connLayer — already disposed above

    const rects = new Map<string, Rect>()
    for (const o of this.data.objects) rects.set(o.id, this.objectRect(o))
    for (const g of this.data.groups) rects.set(g.id, this.groupRect(g))
    const edit = this.connEdit

    // 2D focus parity: ANY selection enters focus mode; a connection is
    // highlighted when it is selected itself or leaves a selected shape/group
    // (isConnectionHighlighted — object and group sources are both "fromId is
    // selected"). Highlighted → highlight stroke + focus animation; the rest
    // dim to 15%, exactly the flat engine's numbers.
    const focusMode = this.selectedIds.size > 0
    const styleArmed = this.connAnimationsEnabled && this.highlightStyle !== 'none'
    const anim = resolveConnectionAnimation(skin)
    const objectById = new Map(this.data.objects.map((object) => [object.id, object]))
    const groupById = new Map(this.data.groups.map((group) => [group.id, group]))
    // lit cables: pre-slot every plug point (corner clamp + same-wall pitch)
    const plugSlots = this.renderProfile === 'lit' ? this.computePlugSlots(rects, objectById) : null

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
      const width = highlighted
        ? Math.max(2.6, skin.connections.strokeWidthHighlight * 1.2)
        : Math.max(2.2, skin.connections.strokeWidth * 1.2)
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
      const geom = connectionPath(effConn, fromRect, toRect)
      this.connGeoms.set(conn.id, geom)
      const pts = samplePath(geom, 24)
      const dash: [number, number] | null = conn.type === 'dashed' ? [5, 4] : conn.type === 'dotted' ? [2, 3] : null
      const liveCable = this.renderProfile === 'lit' && !dash
      let cableProfile: CableProfile | null = null
      let body: THREE.BufferGeometry | null
      if (liveCable) {
        // Physical plug anchoring (cables must visibly connect) — each end
        // enters ITS node's wall at a plug height computed from that node's
        // REAL base (group platform vs board), and the run rests just above
        // the HIGHER of the two supports. A single global layer height would
        // bury the mid-span inside group platforms and leave ends floating
        // beside the walls. Drum ends first snap from the rect
        // border onto the cylinder so the boot touches porcelain, not air.
        const layerY = CAMERA_PRESETS[this.preset].plat + CONNECTION_LIFT
        const cableR = highlighted ? 2.9 : 2.4
        const from = this.cableEndpointFacts(conn.fromId, fromObject, fromRect, groupById.has(conn.fromId))
        const to = this.cableEndpointFacts(conn.toId, toObject, toRect, groupById.has(conn.toId))
        // final plug points (computePlugSlots): un-trimmed (the drawn 2D
        // path stops 4 px / 14 px short for the flat arrowhead), clamped off
        // the rounded corners, same-wall neighbours spread to PLUG_PITCH
        pts[0] = plugSlots?.get(`${conn.id}:from`) ?? { x: geom.fromEdge.x, y: geom.fromEdge.y }
        pts[pts.length - 1] = plugSlots?.get(`${conn.id}:to`) ?? { x: geom.toEdge.x, y: geom.toEdge.y }
        if (from.snapCenter) snapOntoDrum(pts, 0, from.snapCenter)
        if (to.snapCenter) snapOntoDrum(pts, pts.length - 1, to.snapCenter)
        // plugs enter PERPENDICULAR to their wall (radially for drums),
        // whatever the routed approach angle
        const inwardFrom = from.snapCenter ? drumInward(pts[0], from.snapCenter) : FACE_INWARD[geom.fromEdge.face]
        const inwardTo = to.snapCenter ? drumInward(pts[pts.length - 1], to.snapCenter) : FACE_INWARD[geom.toEdge.face]
        let total = 0
        for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
        const supportY = Math.max(from.wallBase, to.wallBase)
        cableProfile = cableProfileFor(
          from.plugY - layerY,
          to.plugY - layerY,
          supportY + cableR + 1.0 - layerY,
          total,
        )
        // Cable tint: light appearance = WHITE PLASTIC — near-cream tubes,
        // a whisper of the theme
        // stroke kept for hue; ports mold a step deeper for the socket read.
        // Dark appearance keeps the warm cocoa so wires stay readable on
        // dark boards. Both bake as vertex colors (one draw).
        const lightMode = !this.palette!.dark
        const cableCss = highlighted
          ? strokeCss
          : lightMode
            ? mixColors(strokeCss, '#EFE7D9', 0.78)
            : mixColors(strokeCss, '#8F7A5E', 0.46)
        const plugCss = lightMode
          ? mixColors(cableCss, '#A2957F', 0.42)
          : mixColors(cableCss, '#241E18', 0.58)
        body = buildCableTube(
          pts,
          cableR,
          cableProfile,
          new THREE.Color(colorAlpha(cableCss).color),
          new THREE.Color(colorAlpha(plugCss).color),
          inwardFrom,
          inwardTo,
        )
        this.cableDebug.push({
          id: conn.id,
          from: cableEndDebug(
            from,
            pts[0],
            inwardFrom,
            fromRect,
            from.snapCenter ? `${conn.fromId}:drum` : `${conn.fromId}:${geom.fromEdge.face}`,
          ),
          to: cableEndDebug(
            to,
            pts[pts.length - 1],
            inwardTo,
            toRect,
            to.snapCenter ? `${conn.toId}:drum` : `${conn.toId}:${geom.toEdge.face}`,
          ),
          restY: cableProfile.yRest + layerY,
          supportY,
        })
      } else {
        body = buildRibbon(pts, width, dash)
      }
      if (body) {
        // Ribbon (unlit / dashed): DoubleSide — the strip's winding follows
        // the path direction, so a single-sided material would cull (and
        // un-pick) half the connections. Cable (lit): a closed tube — normal
        // front-side depth-written surface that sits IN the scene, WHITE css
        // so the baked vertex colors show verbatim.
        const mesh = liveCable
          ? new THREE.Mesh(body, dim(this.surface('ribbon', '#FFFFFF', { vertexColors: true })))
          : new THREE.Mesh(body, dim(this.surface('ribbon', strokeCss, { depthWrite: false, side: THREE.DoubleSide })))
        mesh.userData.pick = { kind: 'connection', id: conn.id } satisfies PickTarget
        if (liveCable) {
          // The wire's own shadow is the reference image's tangibility cue —
          // worth its depth-pass cost (~1 draw per connection).
          mesh.castShadow = true
          mesh.receiveShadow = true
          // Surface finish: glossy white plastic in the light appearance (a
          // braid bump reads as coarse ribs up close); dark boards keep
          // a satin finish so the cocoa wire doesn't glare.
          const m = mesh.material as THREE.MeshStandardMaterial
          if ('roughness' in m) {
            m.roughness = this.palette!.dark ? 0.55 : 0.32
            m.needsUpdate = true
          }
        }
        this.connLayer.add(mesh)
        this.pickables.push(mesh)
      }

      // focus animation on the highlighted (source/selected) connection
      if (highlighted && styleArmed) this.buildFlowEffect(geom, pts, width, anim, cableProfile)

      // arrowhead (engine: 14px, at the target edge point) — the cable body
      // already carries its cone; only the flat ribbon needs the triangle
      if (!liveCable) {
      const a = geom.arrowTip
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
      }

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
        const mid = { x: pt.x - tan.y * offset, y: pt.y + tan.x * offset }
        const lw = approxTextWidth(conn.label, SUB_SIZE) + 14
        // lit profile: the label hovers just above the CABLE at its t (the
        // cable now dives to its supports — a label left at layer height
        // would float mid-air far from its wire)
        const labelLift = cableProfile ? cableYAt(cableProfile, t) + 5.5 : 0
        const plate = this.plate(lw, 17, this.pxr(5), this.surface('connLabel', skin.connections.labelBg))
        dim(plate.material as THREE.MeshBasicMaterial)
        plate.position.set(mid.x - lw / 2, labelLift + 0.4, mid.y - 8.5)
        plate.userData.pick = { kind: 'connLabel', id: conn.id } satisfies PickTarget
        this.connLayer.add(plate)
        this.pickables.push(plate)
        const label = this.addText(
          {
            text: conn.label,
            font: 'inter400',
            size: SUB_SIZE,
            color: colorAlpha(skin.connections.labelText).color,
            anchorX: 'center',
            anchorY: 'middle',
          },
          this.connTexts,
        )
        label.fillOpacity = alpha
        label.position.set(mid.x, labelLift + 0.55, mid.y)
        this.connLayer.add(label)
      }
    }

    // edit chrome for the single selected connection (write mode only)
    const selectedConnId = this.singleSelectedConnId()
    if (!this.readonly_ && selectedConnId) this.buildConnEditHandles(selectedConnId, rects)
    this.requestRender()
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
    cableProfile: CableProfile | null = null,
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
    // Under the lit profile the spark rides ON the cable (same height profile
    // as buildCableTube — plug, dive, rest, rise) instead of gliding on a
    // flat plane — the reference image's glowing-particle-on-a-wire read.
    const travelingDot = (cycle: number): ((now: number) => void) => {
      const dot = new THREE.Group()
      dot.add(
        disc(9, anim.color, 0.35, true, 0).mesh,
        disc(4, '#FFFFFF', 0.95, false, 0.1).mesh,
        disc(2.5, anim.color, 1, false, 0.2).mesh,
      )
      dot.position.y = 1.0
      this.connLayer.add(dot)
      unit.dot = dot
      return (now) => {
        const t = (now % cycle) / cycle
        unit.lastT = t
        const p = pathPoint(geom, t)
        const y = cableProfile ? cableYAt(cableProfile, t) + 3.4 : dot.position.y
        dot.position.set(p.x, y, p.y)
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
    for (const hit of hits) {
      // Raycaster does NOT skip invisible meshes — an LOD-hidden decoration
      // (e.g. the expand glyph on a far-away card) must not swallow the click.
      if (!hit.object.visible) continue
      const voxelIds = hit.object.userData.voxelIds as string[] | undefined
      if (voxelIds && hit.instanceId !== undefined) {
        const id = voxelIds[hit.instanceId]
        const target: PickTarget | undefined = id ? { kind: 'voxel', id } : undefined
        if (target && (!kinds || kinds.has(target.kind))) return { target, point: hit.point }
      }
      const pick = hit.object.userData.pick as PickTarget | undefined
      if (pick && (!kinds || kinds.has(pick.kind))) return { target: pick, point: hit.point }
    }
    return null
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
      canvas.addEventListener(type, fn as EventListener, opts)
      this.detachFns.push(() => canvas.removeEventListener(type, fn as EventListener))
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
          return
        }
        if (t.kind === 'connWaypoint') {
          const conn = this.data.connections.find((c) => c.id === t.id)
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
              t: conn.labelPosition ?? 0.5,
              offset: Math.max(-40, Math.min(40, conn.labelOffset ?? 0)),
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
          p.groupDrag = {
            rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
            groupPos: grp?.position ? { x: grp.position.x, y: grp.position.y } : null,
            members: new Map(
              (grp?.objectIds ?? []).flatMap((id) => {
                const o = this.data.objects.find((x) => x.id === id)
                return o ? [[id, { x: o.position.x, y: o.position.y }] as const] : []
              }),
            ),
          }
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
            // 2D contract: every member rides along by the drag delta; the
            // stored group position (when set) shifts by the same delta
            const gd = p.groupDrag
            const dx = pos.x - gd.rect.x
            const dy = pos.y - gd.rect.y
            for (const [id, start] of gd.members)
              this.callbacks.onObjectMove(id, { x: start.x + dx, y: start.y + dy })
            if (gd.groupPos) this.callbacks.onGroupMove(p.id, { x: gd.groupPos.x + dx, y: gd.groupPos.y + dy })
            else if (gd.members.size === 0) this.callbacks.onGroupMove(p.id, pos)
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
            this.callbacks.onConnectionLabelMove?.(edit.connId, edit.t, edit.offset)
          }
          this.callbacks.onDragEnd?.()
        }
        this.buildConnections() // drop in-flight overrides; store echo re-syncs
        return
      }
      const wasDrag = p.mode === 'dragNode' || p.mode === 'dragGroup'
      const wasNode = p.mode === 'dragNode'
      const dragId = p.id
      const clicked = !p.moved
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
            // 2D drag-end: each member snaps where it landed; so does the
            // stored group position
            const gd = p.groupDrag
            const dx = p.lastPos.x - gd.rect.x
            const dy = p.lastPos.y - gd.rect.y
            for (const [id, start] of gd.members)
              this.callbacks.onObjectMove(id, snapTo({ x: start.x + dx, y: start.y + dy }))
            if (gd.groupPos) this.callbacks.onGroupMove(dragId, snapTo({ x: gd.groupPos.x + dx, y: gd.groupPos.y + dy }))
            else if (gd.members.size === 0) this.callbacks.onGroupMove(dragId, snapTo(p.lastPos))
          } else this.callbacks.onGroupMove(dragId, snapTo(p.lastPos))
        }
        this.callbacks.onDragEnd?.()
      }
      p.lastPos = null
      p.groupDrag = null
      this.clearSmartGuides(true)
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
      if (wasPlacementDrag && p.moved) this.callbacks.onDragEnd?.()
      canvas.style.cursor = 'default'
    })

    on('wheel', (e) => {
      e.preventDefault()
      // wheel dolly never sets pointer.mode — hold the showcase drift explicitly
      if (this.showcase) this.showcaseHoldUntil = performance.now() + SHOWCASE_RESUME_MS
      this.rig.dollyBy(Math.exp((e.deltaY / 100) * 0.18))
      // Dolly is immediate (no tween) so the settle-edge in frameTick never
      // fires — without this, labels hidden by the projected-size LOD stayed
      // hidden after wheel-zooming in until something else forced a rebuild
      // (text would only appear after clicking a shape).
      this.updateNodeLod()
    }, { passive: false })

    on('contextmenu', (e) => e.preventDefault())

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

/** Flat ribbon (y=0 strip) through `pts` with the given width; optional
 * [dash, gap] pattern measured along arc length. `withT` adds per-vertex
 * `aT` (normalized arc 0=source→1=target) and `aV` (cross-axis −1→+1)
 * attributes for the focus-flow band shaders. */
/** How far the cable body reaches past the routed border point INTO the node
 * wall — swallows the slab's bevel recession so the tube and boot always
 * touch porcelain, never hover beside it. */
const CABLE_EMBED = 2.5
/** Minimum spacing between two plugs on the SAME wall (the boot flares to
 * ~±5 px around its point — closer plugs merge into one blob). */
const PLUG_PITCH = 14
/** Plug points keep clear of the slab's rounded corners (CARD_RADIUS 14 —
 * an arriving tube there would end in the air): corner
 * radius + collar radius + breathing room. */
const PLUG_CORNER_MARGIN = 20

/** Inward (into the wall) horizontal direction for each rect face — plugs
 * enter PERPENDICULAR to the wall like real patch connectors, whatever the
 * routed approach angle. */
const FACE_INWARD: Record<Face, { x: number; z: number }> = {
  top: { x: 0, z: 1 },
  bottom: { x: 0, z: -1 },
  left: { x: 1, z: 0 },
  right: { x: -1, z: 0 },
}

function drumInward(p: { x: number; y: number }, c: { x: number; z: number }): { x: number; z: number } {
  const dx = c.x - p.x
  const dz = c.z - p.y
  const l = Math.hypot(dx, dz) || 1
  return { x: dx / l, z: dz / l }
}

/** Point-in-rounded-rect (the slab SOLID, not its bounding rect): inside the
 * rect AND, within a corner square, inside the quarter circle. The e2e
 * `endInside` gate MUST test this solid — the rect version stayed green
 * while a corner arrival visibly died in the air. */
function pointInRoundedRect(px: number, pz: number, rect: Rect, r: number): boolean {
  if (px < rect.x || px > rect.x + rect.w || pz < rect.y || pz > rect.y + rect.h) return false
  const qx = Math.max(rect.x + r - px, 0, px - (rect.x + rect.w - r))
  const qz = Math.max(rect.y + r - pz, 0, pz - (rect.y + rect.h - r))
  return qx * qx + qz * qz <= r * r
}

/** One cable end's wall facts (world heights) + the e2e-facing verdicts. */
interface CableEndDebug {
  plugY: number
  wallBase: number
  wallTop: number
  endInside: boolean
  /** Final plug point (world XZ) — pitch assertions. */
  at: { x: number; z: number }
  /** `${nodeId}:${face|drum}` — plugs sharing a wall must keep PLUG_PITCH. */
  wallKey: string
}
interface CableDebugEntry {
  id: string
  from: CableEndDebug
  to: CableEndDebug
  /** World height of the mid-run rest. */
  restY: number
  /** World top of the higher support under the two ends. */
  supportY: number
}

/** Move a routed endpoint from the standee's RECT border onto its drum wall:
 * the 2D anchor rides the rectangle, but the 3D store is a cylinder inset in
 * that footprint — without the snap the plug floats in the gap. */
function snapOntoDrum(pts: { x: number; y: number }[], idx: number, c: { x: number; z: number }): void {
  const p = pts[idx]
  const dx = p.x - c.x
  const dz = p.y - c.z
  const len = Math.hypot(dx, dz)
  const r = DRUM_R - 1.5
  if (len <= r || len < 1e-3) return
  pts[idx] = { x: c.x + (dx / len) * r, y: c.z + (dz / len) * r }
}

/** e2e-facing verdict for one end: where the plug lands on the wall span and
 * whether the embedded tube end is truly INSIDE the node SOLID (rounded rect
 * for cards/groups, cylinder for drums) — the regression net for cables that
 * visibly fail to connect. Mirrors buildCableTube's embed math exactly. */
function cableEndDebug(
  facts: { wallBase: number; wallTop: number; plugY: number; snapCenter: { x: number; z: number } | null },
  p: { x: number; y: number },
  inward: { x: number; z: number },
  rect: Rect,
  wallKey: string,
): CableEndDebug {
  const ex = p.x + inward.x * CABLE_EMBED
  const ez = p.y + inward.z * CABLE_EMBED
  const endInside = facts.snapCenter
    ? Math.hypot(ex - facts.snapCenter.x, ez - facts.snapCenter.z) <= DRUM_R
    : pointInRoundedRect(ex, ez, rect, CARD_RADIUS)
  return {
    plugY: facts.plugY,
    wallBase: facts.wallBase,
    wallTop: facts.wallTop,
    endInside,
    at: { x: p.x, z: p.y },
    wallKey,
  }
}

/** LIT-profile connection body — the reference image's patch cable. A round
 * tube follows the routed XZ samples with `cableYAt`'s vertical shape (leave
 * the source wall at plug height, ease down onto the support, rise into the
 * target wall), entering both walls horizontally through molded plugs:
 * collar flange straddling the wall face + boot on the cable, and on the
 * arrival end a widening cone tucked into the boot — the direction cue (no
 * floating flat arrow in the lit profile). Every part bakes its tone into
 * vertex colors and merges — ONE draw call per connection, exactly like the
 * ribbon it replaces. Dashed/dotted connections keep the flat ribbon (dash
 * gaps have no round-cable reading). */
function buildCableTube(
  pts: { x: number; y: number }[],
  radius: number,
  profile: CableProfile,
  cableColor: THREE.Color,
  plugColor: THREE.Color,
  inwardFrom?: { x: number; z: number },
  inwardTo?: { x: number; z: number },
): THREE.BufferGeometry | null {
  if (pts.length < 2) return null
  let total = 0
  const arcs: number[] = [0]
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    arcs.push(total)
  }
  if (total < 6) return null

  const v3 = pts.map((p, i) => new THREE.Vector3(p.x, cableYAt(profile, arcs[i] / total), p.y))
  const safeDir = (a: THREE.Vector3, b: THREE.Vector3) => {
    const d = new THREE.Vector3(a.x - b.x, 0, a.z - b.z)
    return d.lengthSq() < 1e-6 ? new THREE.Vector3(1, 0, 0) : d.normalize()
  }
  // horizontal entry directions INTO each wall (perpendicular, from the
  // caller's wall facts; chord fallback) + the border points, captured
  // before the embed extension mutates the ends
  const dirFrom = inwardFrom ? new THREE.Vector3(inwardFrom.x, 0, inwardFrom.z) : safeDir(v3[0], v3[1])
  const dirTo = inwardTo ? new THREE.Vector3(inwardTo.x, 0, inwardTo.z) : safeDir(v3[v3.length - 1], v3[v3.length - 2])
  const borderFrom = v3[0].clone()
  const borderTo = v3[v3.length - 1].clone()
  v3.unshift(borderFrom.clone().addScaledVector(dirFrom, CABLE_EMBED))
  v3.push(borderTo.clone().addScaledVector(dirTo, CABLE_EMBED))

  const curve = new THREE.CatmullRomCurve3(v3, false, 'centripetal', 0.5)
  const tubularSegments = Math.max(32, Math.min(140, Math.round(total / 12)))
  const parts: THREE.BufferGeometry[] = []
  const bake = (geo: THREE.BufferGeometry, c: THREE.Color) => {
    const count = geo.getAttribute('position').count
    const colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return geo
  }
  parts.push(bake(new THREE.TubeGeometry(curve, tubularSegments, radius, 10, false), cableColor))

  // Flush GROMMET port (a collar+cone reads as a ribbed puck and a faceted
  // spike up close; cables enter clean rounded ports; direction lives in the
  // label + traveling dot, not an arrow cone). `along` is the part center's offset along the INWARD
  // direction from the border point (negative = outside the wall):
  //   cable → [strain-relief taper −4.8] → [sleeve −1.2] →
  //   [grommet ring −0.2, hugging the wall face] → wall
  const UP = new THREE.Vector3(0, 1, 0)
  const plug = (border: THREE.Vector3, inward: THREE.Vector3) => {
    const q = new THREE.Quaternion().setFromUnitVectors(UP, inward)
    const at = (geo: THREE.BufferGeometry, along: number) => {
      geo.applyQuaternion(q)
      geo.translate(border.x + inward.x * along, border.y, border.z + inward.z * along)
      parts.push(bake(geo, plugColor))
    }
    const ring = new THREE.TorusGeometry(radius * 1.45, radius * 0.55, 10, 18)
    ring.rotateX(Math.PI / 2) // torus axis Z → Y, so the quaternion aims it
    at(ring, -0.2)
    at(new THREE.CylinderGeometry(radius * 1.25, radius * 1.25, 3.4, 18), -1.2)
    // molded taper: wide at the sleeve, easing onto the cable — smooth side
    // normals, no cone apex
    at(new THREE.CylinderGeometry(radius * 1.4, radius * 1.05, 4.5, 18), -4.8)
  }
  plug(borderFrom, dirFrom)
  plug(borderTo, dirTo)

  const merged = mergeGeometries(parts)
  for (const part of parts) part.dispose()
  return merged
}

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
