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
 * `smartGuideInfo`, `cableInfo`) cannot be constrained this way at all — a
 * spread is exempt from excess-property checking — and `cityFabricInfo():
 * unknown` is decorative by construction. Those five are worth what a spec
 * happens to read from them, and no more. Named here rather than implied away.
 *
 * The e2e side then imports this type instead of restating it
 * (`e2e/support/probes.d.ts`), so there is exactly one description of the probe
 * and the compiler owns it.
 *
 * ## Kept deliberately structural
 *
 * Several members return values built from three.js objects (`getPose`,
 * `enterStartPose`, `rendererInfo`, `cableInfo`, `smartGuideInfo`). Their
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

/** One end of a lit cable run: where it plugs in, and the wall span it must
 *  land inside. */
export interface Scene3dCableEnd {
  plugY: number
  wallBase: number
  wallTop: number
  endInside: boolean
  at: { x: number; z: number }
  wallKey: string
}

export interface Scene3dCable {
  id: string
  from: Scene3dCableEnd
  to: Scene3dCableEnd
  restY: number
  supportY: number
}

/** Dev-only introspection installed by `Scene3D.mount()` under
 *  `import.meta.env.DEV`. Never used by app code. */
export interface Scene3dProbe {
  getPose(): Scene3dPose
  isCameraAnimating(): boolean
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
  /** Lit cable anatomy — every plug must land INSIDE its node's wall span. */
  cableInfo(): Scene3dCable[]
  /** Showcase auto-orbit: on, and currently held by a pointer? */
  showcaseInfo(): { on: boolean; holding: boolean }
  nodeWorldPos(id: string): { x: number; y: number } | null
  nodeIds(): string[]
  /** The background world's fabric manifest (Montréal city ring). Genuinely
   *  untyped at the source: read off `userData`, shape owned by the pack. */
  cityFabricInfo(): unknown
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
