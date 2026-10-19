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
 * THE SHAPE OF `window.__scene3d`, in ONE place, checked against the object
 * that is actually installed.
 *
 * `Scene3D.mount()` installs a dev-only probe literal that e2e specs read. A
 * `declare global` in a spec file is a claim about `Scene3D.ts` that
 * `Scene3D.ts` never sees; per-spec copies drift apart (missing leak-accounting
 * fields, members the literal does not install) and, merged into one program
 * (`tsconfig.e2e.json`), conflict. So the shape lives here, once.
 *
 * ## `satisfies`
 *
 * The install site reads `window.__scene3d = { …literal… } satisfies
 * Scene3dProbe`, which makes `npm run build` the comparison between this
 * declaration and the installed object.
 *
 * ## Exactly what that gate constrains (measured by mutation)
 *
 * | mutant | `npm run build` |
 * |---|---|
 * | member added to the literal, undeclared here | KILLED, TS2353 |
 * | member declared here, missing from the literal | KILLED, TS1360 |
 * | key at the install site renamed | KILLED, TS2551 |
 * | field's TYPE changed in a nested interface | KILLED, TS2322 |
 * | field REMOVED from `Scene3dSceneStats` / `Scene3dDecorInfo` | KILLED, TS2353 — **only because their arrows carry an explicit return annotation** |
 * | field removed from an inline return type (`contextInfo`) | **SURVIVES** |
 * | field removed from a spread-backed return (`rendererInfo`) | **SURVIVES** |
 *
 * The reason for the split: `satisfies` checks each arrow BODY for
 * assignability, and a function returning more than it promises is assignable.
 * Freshness — and therefore excess-property checking — applies only where the
 * arrow declares its own return type. So `sceneStats` and `decorInfo` are
 * annotated (`(): Scene3dSceneStats =>`, `(): Scene3dDecorInfo =>`) and are
 * fully constrained (e.g. `geometries`/`textures` disappearing is a build
 * error).
 *
 * The spread-backed members (`getPose`, `enterStartPose`, `rendererInfo`,
 * `smartGuideInfo`) cannot be constrained this way at all — a spread is
 * exempt from excess-property checking — and `cityFabricInfo(): unknown` is
 * decorative by construction. Those are worth what a spec happens to read
 * from them, and no more. Named here rather than implied away.
 *
 * The e2e side then imports this type instead of restating it
 * (`e2e/support/probes.d.ts`), so there is exactly one description of the probe
 * and the compiler owns it.
 *
 * ## Kept deliberately structural
 *
 * Several members return values built from three.js objects (`getPose`,
 * `enterStartPose`, `rendererInfo`, `smartGuideInfo`). Their
 * declarations below name the fields the assertions use, not three's own types:
 * the probe spreads those objects, and a spread is exempt from excess-property
 * checking, so a narrower declaration stays honest while keeping this file free
 * of a three.js import it does not need.
 */

/** Camera framing, as the orbit rig reports it. */
export interface Scene3dPose {
  polar: number
  azimuth: number
  distance: number
  targetX: number
  targetZ: number
  fov: number
}

/**
 * Perf and render-profile counters. The profile fields are the PBR-migration
 * ground truth — an unlit theme must report `'unlit'` / 0 lights / no shadow map
 * — and `geometries`/`textures` are the GPU leak accounting: three decrements
 * them on `.dispose()`, so a rebuild path that leaks shows as a climbing
 * plateau.
 */
export interface Scene3dSceneStats {
  nodes: number
  connections: number
  meshes: number
  texts: number
  visibleTexts: number
  calls: number
  triangles: number
  frame: number
  pixelRatio: number
  geometries: number
  textures: number
  renderProfile: 'unlit' | 'lit'
  lightsCount: number
  shadowMapEnabled: boolean
  envMap: boolean
  composerPasses: number
  qualityTier: 'high' | 'medium' | 'low'
  shadowCasters: number
}

/** The decoration layer's live state. */
export interface Scene3dDecorInfo {
  packId: string | null
  density: string | null
  seed: number | null
  boardStyle: string | null
  background: string | null
  /** Background world actually built by the engine (lit profile only). */
  world: string | null
  visible: boolean
  archetypes: { id: string; count: number }[]
}

/** One connection's flat arrowhead and its line as drawn, measured through
 *  the live camera (quality pass "arrows"). Lit (`ink`): the inked flat
 *  ribbon and 2D arrowhead of inkLine.ts, at the scale its shader floor
 *  gives it; unlit: Clean's 14 × ±5 triangle. */
export interface Scene3dArrowhead {
  connId: string
  toId: string
  kind: 'flat'
  /** The lit ink line (inkLine.ts); false: an unlit ribbon. */
  ink: boolean
  drawn: boolean
  /** World tip / back-edge centre, at the drawn scale. */
  tip: { x: number; y: number; z: number }
  base: { x: number; y: number; z: number }
  /** Projected tip-to-base length, base width and largest span (css px). */
  lengthPx: number
  widthPx: number
  /** The base's extent SQUARE to the on-screen axis (css px) — what the eye
   * reads as the head's width; widthPx is corner to corner, which a skewed
   * (slanted, off-centre) view inflates along the axis. */
  thicknessPx: number
  /** The projected tip, base centre and base corners (client css px). */
  screenTri: { tip: { x: number; y: number }; base: { x: number; y: number }; a: { x: number; y: number }; b: { x: number; y: number } }
  sizePx: number
  /** The uniform scale the projected floor gives the head (1: none). */
  scale: number
  /** inkLine.inkCapGrowth at the tip: the factor its ceilings wear. */
  capK: number
  /** Tip and back both project inside the canvas, in front of the camera. */
  onScreen: boolean
  /** Fraction of the head's interior sample points the camera sees first
   *  (no node, no label plate in front). */
  visibleFraction: number
  /** Plan distance (world px) from the tip to the target's 3D silhouette —
   *  a lit drum's pad circle, else its rect (negative: inside it). */
  tipClear: number
  /** Dashed / dotted lit lines: the pattern (world px) and the factor the
   *  fragment lengthens it by at this framing (INK_DASH_MIN_CSS), with
   *  centreline points every 0.5 world px of arc (client css px) — those
   *  the camera sees over open board — for the harness to read the dash
   *  rhythm back from the PNG. Null for a solid line. */
  dash: {
    on: number
    period: number
    scale: number
    pts: { arc: number; x: number; y: number }[]
  } | null
  /** The line is highlighted (selected / leaves the selection). */
  highlighted: boolean
  /** The core's opacity (focus dim, hidden-tag preview). */
  alpha: number
  /** The core's colour, the line's 2D stroke under the same skin, and its
   *  casing (halo / rim), if drawn. */
  css: string
  strokeCss: string
  casing: { kind: 'halo' | 'rim'; css: string; opacity: number } | null
  /** The head's projected triangle (client css px). */
  hull: { areaPx: number; pts: { x: number; y: number }[] }
  /** Client-px points the camera sees inside the head, and on the support
   *  just past its casing off both flanks (the harness reads the PNG). */
  face: { x: number; y: number }[]
  ring: { x: number; y: number }[]
  /** The line: up to 24 centreline samples on the canvas (`samples`), those
   *  the camera sees (`pts`): the centre, a point 8 css px off either side
   *  square to the line on screen (`board`: 4 and 8 css px either side show
   *  the board — no node solid, no plate — and no other line runs near),
   *  the core's projected width there (the shader's floor and
   *  grazing math, inkLine.stripCoreWidthPx) and how much its in-plane
   *  normal is foreshortened (`f`, 1 = seen square). */
  line: {
    samples: number
    seen: number
    pts: {
      c: { x: number; y: number }
      l: { x: number; y: number }
      r: { x: number; y: number }
      board: boolean
      widthPx: number
      /** One side of its casing (halo / rim), css px, same mirror. */
      rimPx: number
      /** What an unselected ink core would draw at the same spot (css px). */
      plainWidthPx: number
      /** inkLine.inkCapGrowth there. */
      capK: number
      f: number
    }[]
  }
  /** The ONE selected connection: it wears the selection halo. */
  selected: boolean
  /** Its halo (INK_SELECT_HALO), null when none. */
  selectHalo: { css: string; opacity: number; widthCss: number } | null
}

/** What the connection layer is made of (quality pass "lines": no tube,
 *  cone or torus is left in it; ink meshes — casings + cores — and cores
 *  by count). */
export interface Scene3dConnLayer {
  geometryTypes: Record<string, number>
  inkMeshes: number
  inkCores: number
  shadowCasters: number
  /** The lit ink set picked against the board (null: unlit). */
  inkSet: 'darkInk' | 'lightInk' | null
}

/** Dev-only introspection installed by `Scene3D.mount()` under
 *  `import.meta.env.DEV`. Never used by app code. */
/** One loop frame that took ≥ 40 ms (perfInfo().slowFrames). */
/** The city's Mont-Royal landmark as drawn (quality pass "montroyal"). */
export interface Scene3dCityMount {
  source: 'glb' | 'procedural'
  min: [number, number, number]
  max: [number, number, number]
  radius: number
  triangles: number
}

export interface Scene3dSlowFrame {
  /** performance.now() at the frame's start. */
  atMs: number
  ms: number
  /** `builds` when it ran. */
  build: number
  kind: string
  /** Programs created during the frame — a synchronous LINK. */
  newPrograms: number
  /** Textures / geometries first uploaded during the frame — an UPLOAD. */
  newTextures: number
  newGeometries: number
  /** The drawing buffer was resized since the previous frame — a target
   * REALLOCATION paid by this frame. */
  resized: boolean
  /** The frame re-rendered the cached shadow map (shadowsDirty). */
  shadow: boolean
  /** Frames rendered through the post stack before this one ended. */
  frame: number
  /** The floor-dressing fade (0 undressed … 1 dressed) when it ran. */
  floorAlpha: number
  /** ms since the running floor fade started (-1: none running). */
  fadeMs: number
}

export interface Scene3dProbe {
  getPose(): Scene3dPose
  /** The active preset's base pose over the content (where entering 3D lands). */
  presetPose(): Scene3dPose
  /** True while the camera moves — AND while a committed enter has not
   * started its tween yet or shader programs are still linking. */
  isCameraAnimating(): boolean
  /** A committed enter morph is waiting on its compile (tween not started). */
  enterPending(): boolean
  /** Morph floor fade: 0 = flat 2D reading, 1 = dressed board. */
  floorAlpha(): number
  /** The pose the last enter morph STARTED from (framing identity probe). */
  enterStartPose(): Scene3dPose | null
  /** Rendered RGBA at client coords (renders + reads the drawing buffer). */
  readPixel(clientX: number, clientY: number): { r: number; g: number; b: number; a: number }
  /** Blend/depth state of the floor materials (the layering invariant). */
  floorFadeState(): { transparent: boolean; depthWrite: boolean }[]
  /** Theme 3D surface state (edge glows, motions, environment). */
  theme3dInfo(): {
    hasTheme: boolean
    glowCount: number
    motionCount: number
    fog: boolean
    bgIsGradient: boolean
  }
  nodeCount(): number
  /** three's own `renderer.info.render`, spread. */
  rendererInfo(): { frame: number; calls: number; triangles: number }
  sceneStats(): Scene3dSceneStats
  /** GL context-loss drill: `restores` is how many times the restore handler
   *  genuinely ran, which is what makes the drill falsifiable. */
  contextInfo(): { lost: boolean; restores: number }
  forceContextLoss(): void
  forceContextRestore(): void
  /** Force the lit post tier (deterministic CI budgets). */
  setQualityTier(tier: 'high' | 'medium' | 'low'): void
  decorInfo(): Scene3dDecorInfo
  /** Wall-clock cost of the last full rebuild (floor + decor split out). */
  perfInfo(): {
    totalMs: number
    floorMs: number
    decorMs: number
    builds: number
    firstFrameMs: number
    /** Live GPU programs (`renderer.info.programs`) — each one is a compile. */
    programs: number
    programNames: string[]
    /** Every live program's cache key — a gesture's added programs are a
     * diff of these (names are the materials', '' for nearly all). */
    programKeys: string[]
    /** Wall time of the first composed frame after the post stack went live. */
    compileMs: number
    postFirstMs: number
    /** Programs that first composed frame still had to link (`name|cacheKey`). */
    postFirstNewPrograms: string[]
    postFirstPriorPrograms: string[]
    /** Shadow-map pass run in its own task ahead of that frame (0: none). */
    postFirstShadowMs: number
    /** `builds` when that frame was measured (-1: this build's is pending). */
    postFirstBuild: number
    /** Was that frame drawn through the post stack? */
    postFirstComposed: boolean
    /** The first-frame probe is armed and has not fired yet. */
    postFirstPending: boolean
    /** The lit post stack is mounted. */
    postLive: boolean
    /** Shadow-depth program variants warmed by the compile gate. */
    depthWarmVariants: number
    /** Last loop frames ≥ 40 ms: when (performance.now), how long, which build. */
    slowFrames: Scene3dSlowFrame[]
    /** Off-screen whole-scene draws the compile gate ran (Scene3D.warmDraw),
     * and the GPU time of the last one (fence-measured, ms). */
    warmDraws: number
    warmDrawMs: number
  }
  /** Threshold (ms) of perfInfo().slowFrames — lowered for a measured window
   * (a 33-50 ms hitch is under every browser long-task floor). */
  setSlowFrameMs(ms: number): void
  /** Render N orbiting frames synchronously (readback-fenced); ms per frame. */
  benchFrames(frames: number): number[]
  /** World positions of every placed instance of one decor archetype. */
  /** `h`: the instance's world height (its geometry's bounding box × scale).
   * `r`: its rotation-safe plan radius about the origin (the box's farthest
   * plan corner × scale) — the quality harness frames whole props on h and r.
   * `corners`: the geometry box's 8 corners in world space, posed — what the
   * harness projects to check a close-up holds the whole prop. */
  decorProps(archetypeId: string): {
    x: number
    y: number
    z: number
    scale: number
    h: number
    r: number
    corners: [number, number, number][]
  }[]
  /** The last built slab: world x/z of its top-left corner, its size, the
   * slab top's height and the desk plane's (view3d quality loop 4 r4: the
   * harness samples board vs desk luminance on it). Null before a floor. */
  boardInfo(): { x: number; z: number; w: number; h: number; topY: number; deskY: number } | null
  /** The last decor placement's input (plain JSON; archetypes as their ids)
   * — the harness replays the live desk layout through `placeDecor`. Null
   * before a decor build. */
  decorPlacementInput(): (Omit<import('./decor/placement').PlacementInput, 'archetypes'> & { archetypes: string[] }) | null
  /** Each placed instance's projected silhouette box (client css px): its
   * posed vertices through the live camera — the quality harness's "nothing
   * stands on a desk prop" gate (quality pass "layout"). Same instance order
   * as decorProps. */
  decorSilhouettes(archetypeId: string): { x0: number; y0: number; x1: number; y1: number }[]
  /** World points → client css px through the live camera. */
  projectWorld(points: { x: number; y: number; z: number }[]): { x: number; y: number }[]
  /** Every built connection's arrowhead and line, through the live camera. */
  arrowheadInfo(): Scene3dArrowhead[]
  /** What the connection layer is built of. */
  connLayerInfo(): Scene3dConnLayer
  /** Jump-cut the camera to a pose (fields left out keep their value). */
  setPose(pose: Partial<Scene3dPose>): void
  /** Showcase auto-orbit: on, and currently held by a pointer? */
  showcaseInfo(): { on: boolean; holding: boolean }
  nodeWorldPos(id: string): { x: number; y: number } | null
  /** Client-px bounding box of each node's projected 3D box (the 8 corners
   * fit-to-screen frames — card slab + plinth, drum + pad + name tag). */
  nodeScreenBoxes(): { id: string; x: number; y: number; w: number; h: number }[]
  /** What each node's face shows now (user regression 2026-10-10: card and
   * drum fonts, sizes and icons must stay the base design at every framing):
   * the title text block (card name / drum floor-tag name) with its font id,
   * size and visibility, the technology / type badge (shown? scale?), and
   * any text in a font the base node faces never used (inter400/600 only). */
  nodeFaces(): {
    id: string
    kind: 'card' | 'store'
    hasTech: boolean
    title: { font: string; size: number; visible: boolean } | null
    badge: { visible: boolean; scale: number } | null
    foreignFonts: string[]
  }[]
  /** Quality pass "labels": each visible lit connection label plate's four
   * corners as drawn (scale + lift), and each node SOLID's points (card slab
   * + plinth rim, drum body, a drum's floor tag), projected through the live
   * camera in client css px. The harness hulls them and gates overlap. */
  labelScreenInfo(): {
    labels: { connId: string; text: string; k: number; pts: { x: number; y: number }[] }[]
    nodes: { id: string; kind: 'card' | 'drum' | 'tag'; pts: { x: number; y: number }[] }[]
  }
  /** Quality pass "labels" round 2 ('PostgreSQL' / 'Elasticsearch' tucked
   * under their drums): each drum floor tag's plate corners in WORLD space as
   * drawn, its text, and whether plate and text show (LOD). */
  storeTagInfo(): { id: string; text: string; visible: boolean; corners: { x: number; y: number; z: number }[] }[]
  /** Quality pass "labels", TASK 2 (crowded wires): what each lit label
   * shows at the current framing — whole, abbreviated (a prefix + an
   * ellipsis) or hidden — whether hover / selection forces it whole, and its
   * own cable's centreline in WORLD space. */
  /** TASK 2: the last build's lit-label placement pass and the settle-time
   * whole / abbreviated / hidden resolve (last, worst, count), in ms. The
   * synchronous connection build (geometry; the placement pass too when it
   * ran inline: last, worst, count) and the last placement job's slicing
   * (slices, longest slice, wall time from start to commit; jobs a newer
   * build cancelled). */
  connLabelPerf(): {
    buildMs: number
    resolveMs: number
    resolveMaxMs: number
    resolves: number
    connBuildMs: number
    connBuildMaxMs: number
    connBuilds: number
    jobSlices: number
    jobMaxSliceMs: number
    jobWallMs: number
    jobsCancelled: number
  }
  connLabelStates(): {
    connId: string
    text: string
    state: 'full' | 'abbreviated' | 'hidden'
    shown: string | null
    drawn: boolean
    textNow: string
    hovered: boolean
    selected: boolean
    /** The scale it wears and how many on-wire spots it may take. */
    k: number
    spots: number
    wire: { x: number; y: number; z: number }[]
  }[]
  /** Quality pass "labels" round 2 ('notifies' / 'writes' drawn ~150 px off
   * their wires): each visible lit connection label plate's WORLD centre and
   * drawn half extents (scale included), and its OWN cable's centreline as
   * built (world points). The harness gates centre-to-own-wire distance. */
  connLabelWireInfo(): {
    connId: string
    text: string
    k: number
    centre: { x: number; y: number; z: number }
    halfW: number
    halfH: number
    wire: { x: number; y: number; z: number }[]
  }[]
  /** Projected cap height (css px) of each VISIBLE node title — a card's
   * name, or a drum's floor-tag name — and of each connection label (with
   * the scale it currently wears). View3d quality loop 3 r2. */
  textLegibility(): {
    titles: { id: string; kind: 'card' | 'store'; capPx: number }[]
    labels: { text: string; capPx: number; k: number }[]
    /** Label growth as buildConnections settled it: the scale the fit
     * framing asks for, and per label the room found (kFree) and whether it
     * slid along its wire to find it. */
    growth: { kWant: number; labels: { connId: string; kFree: number; moved: boolean }[] }
  }
  nodeIds(): string[]
  /** The background world's fabric manifest (Montréal city ring). Genuinely
   *  untyped at the source: read off `userData`, shape owned by the pack. */
  cityFabricInfo(): unknown
  /** The city's Mont-Royal: which mesh it wears (the Blender maquette or
   *  the procedural fallback), its drawn WORLD box and triangles, and its
   *  nominal radius. Null outside the city world. */
  cityMountInfo(): Scene3dCityMount | null
  /** Smart-guide state; `lastDropSnap` is the per-axis decision of the LAST
   *  drop (guide-aligned axis keeps its coordinate, free axis half-grid-snaps). */
  smartGuideInfo(): {
    guides: unknown[]
    candidates: number
    snapped: { x: boolean; y: boolean }
    lastDropSnap: { x: boolean; y: boolean }
  }
  /** The expand glyph's world centre + LOD visibility (Model Viewer drill). */
  expandGlyphInfo(id: string): { x: number; y: number; z: number; visible: boolean } | null
  /** Fly the camera to a world point at the given distance. */
  focusWorld(x: number, z: number, distance: number): void
  /** What a pointer at these client coords would pick (read-only). */
  pickAt(clientX: number, clientY: number): { kind: string; id: string; end?: 'source' | 'target'; index?: number } | null
  connectionIds(): string[]
  /** Focus-flow animation state. `phase` is the first unit's normalized phase —
   *  asserting progress on it is robust to path length and frame pacing. */
  flowInfo(): {
    units: number
    kinds: string[]
    dotPos: { x: number; z: number } | null
    phase: number | null
  }
  /** Grid toggle state + whether the floor dots currently show. */
  gridInfo(): { showGrid: boolean; dotsVisible: boolean }
  /** Mounted theme assets: custom bodies, billboards, floorTexture, sky, voxels. */
  assetInfo(): {
    mounted: string[]
    billboards: number
    floorTextured: boolean
    bgIsEquirect: boolean
    voxels: number
  }
  /** Interactive breakaway floor fragments (scene-only, never persisted). */
  voxelInfo(): {
    count: number
    interactive: boolean
    displaced: number
    fragments: { id: string; x: number; y: number; z: number }[]
  }
  /** Shadow shapes on the board (rect casters must be 'roundedRect'). */
  shadowInfo(): string[]
  /** Technology-icon decals on the board, by icon name. */
  techIcons(): string[]
  /** Every accent-bar segment on the board ("color by" bars), as css colors. */
  accentBars(): string[]
  /** A connection ribbon's effective opacity (focus dim). */
  connectionAlpha(id: string): number | null
  /** Identity anchors on a card's visible top face (local X/Z). */
  cardContentInfo(id: string): {
    role: string
    x: number
    z: number
    lineCount?: number
    fontSize?: number
    truncated?: boolean
    text?: string
  }[]
  selectionIds(): string[]
  /** Per-group platform state: the derived rect (autoSize re-hug), the rect the
   *  plate was BUILT with (fast-path resize proof), the plate's position, and
   *  whether the built plate carries the selection visual. */
  groupInfo(): {
    id: string
    rect: { x: number; y: number; w: number; h: number }
    builtRect: { x: number; y: number; w: number; h: number } | null
    platePos: { x: number; y: number } | null
    selectedVisual: boolean
    members: number
  }[]
  connEditPoints(id: string): {
    from: { x: number; y: number }
    to: { x: number; y: number }
    mid: { x: number; y: number }
    label: { x: number; y: number } | null
    waypoints: { x: number; y: number }[]
    planeY: number
  } | null
  /** Debug/e2e: the lit board's edit handles of the selected connection as
   * drawn this frame — screen centre, drawn diameter, pick radius — and its
   * head's projected triangle, so a gate can measure that no handle covers
   * the head (null: no lit edit chrome). */
  editHandleInfo(): {
    connId: string
    handles: {
      role: 'source' | 'knob' | 'bend' | 'drag' | 'anchor'
      kind: string
      id: number
      visible: boolean
      x: number
      y: number
      diameterPx: number
      /** The body inside the ring at rest (css px). */
      bodyPx: number
      hitPx: number
      /** Line's own height (layer-local y). */
      ly: number
    }[]
    head: { x: number; y: number }[] | null
    /** Distance from the knob's disc edge to the head triangle (css px; null
     * when the knob is hidden). */
    knobHeadGapPx: number | null
    /** Distance from the knob's centre to the head's tip (css px; null when
     * hidden) — it sits on the tip, the 2D destination dot. */
    knobTipPx: number | null
    /** On-screen distance from the source handle centre to the drawn line's
     * first point (css px). */
    sourceOffLinePx: number
    hover: { id: number; t: number }
    pressId: number
    /** The knob's spot is behind its own target shape, so it hides. */
    knobOccluded: boolean
    /** The endpoint-drag preview as built (ink attributes), null when none. */
    preview: { name: string; minCss: number; maxCss: number; dash: number[]; opacity: number; css: string } | null
    /** The flow bead on this line: screen centre, fade, on-screen clearance. */
    bead: { x: number; y: number; fade: number; clearPx: number; phase: number | null } | null
    /** The selection halo's current and resting opacity. */
    haloOpacity: number | null
    haloBase: number | null
    /** Render orders: the handle meshes' highest and lowest, the label
     * plates' / texts' highest. */
    handleOrder: number
    minHandleOrder: number
    labelOrderMax: number
  } | null
}

/**
 * Stamped by `Scene3D.dispose()` and deliberately OUTLIVING the `__scene3d`
 * handle, so the e2e leak drill can read GPU allocations still counted after
 * every disposal ran (a legitimate small residue remains: troika's shared SDF
 * atlas).
 */
export interface Scene3dDisposeResidue {
  geometries: number
  textures: number
}

/**
 * The KEY as well as the value.
 *
 * Assigning through a `Record<string, unknown>` cast with `satisfies` on the
 * value would type-check the literal against ANY key name. Declaring the key
 * here makes `window.__scene3d = { … }` a direct typed assignment: the
 * excess-property error on the value (TS2353), plus the key itself.
 *
 * Precondition, since a global augmentation only applies while its module is in
 * the program: `Scene3D.ts` imports these types, so the app program has it, and
 * `e2e/support/probes.d.ts` imports them too, so the e2e program does. A spec
 * that reached `window.__scene3d` with neither in scope would get TS2339 — a
 * loud failure, not a silent one.
 */
declare global {
  interface Window {
    __scene3d?: Scene3dProbe
    __scene3dDisposeResidue?: Scene3dDisposeResidue
  }
}
