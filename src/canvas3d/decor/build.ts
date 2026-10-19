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

import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CAMERA_PRESETS } from '../presets'
import type { PlacedProp } from './placement'
import type { DecorPackMeta } from './registry'
import { decorAsset, decorAssetsVersion } from './glbAssets'

/**
 * Decor mesh construction: ONE InstancedMesh per archetype (voxel-scatter
 * template — a whole pack costs ≤3 draw calls + its materials), fed by the
 * pure placement result.
 *
 * Geometry is PROCEDURAL (clay-toned primitives merged per archetype); a
 * future GLB pack can replace the geometry source behind the same archetype
 * ids. Geometry/material ownership stays HERE —
 * meshes are tagged `sharedAsset` so `clearRoot` skips them and
 * `disposeDecorBuild()` owns the teardown (pack switches, scene dispose).
 */

export interface DecorBuildResult {
  group: THREE.Group
  /** Per-archetype instance counts (dev probe / e2e). */
  counts: Record<string, number>
  /** Every material in the group (morph-fade registration). */
  materials: THREE.Material[]
  /** Geometry this build OWNS (the merged contact blobs) — everything else is
   * the archetype cache's. Disposed with the build. */
  geometries: THREE.BufferGeometry[]
}

interface ArchetypeGeom {
  geometry: THREE.BufferGeometry
  color: string
  /** Extra lift so the silhouette's origin sits ON the board. */
  groundOffset: number
  /** Standard-material roughness override (default 0.85 — the clay look).
   * Paper/cloth props want a tighter sheen so they separate from the desk. */
  roughness?: number
  /** YAW discipline — see FLAG_YAW_BAND. Set on the ONE archetype with a
   * single readable face that cannot be posed out of trouble: the desk flag's
   * flat upright sheet. Everything else keeps the placement's own rotation. */
  yawBand?: { centres: readonly number[]; spread: number }
  /** FALLEN-LITTER pose — see LEAF_SCATTER. Full-circle yaw plus a per-instance
   * out-of-plane tilt, re-seated exactly. Set on the leaf archetypes. */
  scatter?: ScatterPose
  /** The geometry carries RGBA vertex colours and a drawn contact-shadow decal.
   * The material goes `transparent` with `depthWrite: false` —
   * see the block above `contactShadowGeom` for why both are required. */
  contactDecal?: boolean
  /** Default true. Cleared on the leaf archetypes: a 0.4-unit-thick blade
   * contributes nothing under the sun's 1.5-unit `normalBias`, and a hard
   * silhouette of the decal DISC is the one thing the drawn shadow must not be
   * doubled by. */
  castsShadow?: boolean
  /** Blender-authored archetypes (glbAssets.ts): the print / detail map,
   * multiplied with the vertex colours, and the vein relief. */
  map?: THREE.Texture | null
  normalMap?: THREE.Texture | null
  /** The normal map's scale AS LOADED: GLTFLoader flips y for meshes that
   * shade with derivative tangents (glTF's +Y-up tangent space). */
  normalScale?: THREE.Vector2 | null
  /** glTF metallic-roughness map (G roughness, B metalness), with the
   * material's own metalness factor: the flag's steel pole and brass foot
   * share one mesh with the cloth, so the finish rides a map (glbAssets). */
  metalRoughMap?: THREE.Texture | null
  metalness?: number
  /** Single-surface meshes (cloth, a blade): light both faces. */
  doubleSided?: boolean
}

/** The camera's horizontal look direction at the default `iso` preset. Two
 * things are aimed at it: the flag's sheet normal (FLAG_YAW_BAND) and the
 * *density peak* of the leaves' full-circle yaw (LEAF_SCATTER). */
export const LEAF_READ_AXIS = (CAMERA_PRESETS.iso.rz * Math.PI) / 180

// ── FALLEN LITTER: free yaw + small out-of-plane tilt ──────────────────────
// A single shared yaw is the loudest procedural-scatter tell, so leaf yaw
// covers most of the circle. Three rules keep each blade readable:
//
//  1. THE SQUASH IS AN AXIS, NOT A DIRECTION. The iso camera compresses the
//     ground plane by sin(35°) = 0.574 along one world line, so yaw Y and
//     Y+π deliver the SAME shape. That is why the fence below is TWO arcs and
//     why `depthAxisOffset` folds modulo π.
//  2. A FENCE PLUS A LEAN (see LEAF_YAW_FORBID). The stem→apex azimuth may not
//     land within LEAF_YAW_FORBID of the depth axis, where the lobes collapse
//     onto each other; the two open arcs are 130° each (72% of the circle),
//     and inside an arc the density leans toward BROADSIDE.
//  3. THE TILT DIRECTION IS AIMED. A tilt scales the face by sin(35° ± t), so
//     a random cant direction turns some blades into slivers. The cant is
//     drawn from ±`cantArc` about the viewer instead.
//
// Every pose is a pure function of the placement's own `propId`, so the scene
// is bit-identical run to run (the determinism gate builds twice and compares).
export interface ScatterPose {
  /** Yaw density bias toward the BROADSIDE axis (the centre of each allowed
   * arc — see `scatterYaw`). 0 = uniform inside the arc; must stay < 1 or the
   * warp stops being monotonic and angles inside the arc become unreachable. */
  bias: number
  /** Half-width of the FORBIDDEN arc around the camera's depth axis (and its
   * 180° opposite), radians — see LEAF_YAW_FORBID. Never below it. */
  forbid: number
  /** Half-arc, in radians, that the blade's cant direction is drawn from about
   * LEAF_READ_AXIS. Must stay under π/2 or a blade can cant AWAY from the
   * viewer, which is the sliver case. */
  cantArc: number
  /** Ordinary out-of-plane tilt, [min, max] radians. */
  tilt: readonly [number, number]
  /** Fraction of instances propped steeply, as if leaning on a neighbour. */
  propShare: number
  /** …and the tilt range those get. */
  propTilt: readonly [number, number]
}

const deg = (d: number): number => (d * Math.PI) / 180

// The bias is a lean INSIDE each allowed arc, and 0.5 keeps it a lean: the
// density ratio between the arc's centre (broadside) and its fenced ends is
// (1+bias)/(1−bias) = 3:1, so a crop still shows several different screen
// directions while the obliques the fence admits stay the minority.
//
// THE TILT IS 1-2° ("nearly flat on the surface"). Larger tilts fight the
// ground-plane foreshortening but stand blades on edge. A small tilt is
// affordable because the blade is NEAR-SQUARE (1.250 × 1.225), so yaw barely
// changes its screen extent, and overlapping blades are separated by the tip
// curl (LEAF_CURL_FRAC) and a lit rim wall (`rimOf`), not by angle. It is also
// what makes the merged CONTACT SHADOW decal possible: the decal turns with
// the instance matrix, and at 2° a radius-29 decal swings only ±1.0 unit out
// of the surface (at 26° it would swing ±13 and float).
//
// ── THE DEPTH-AXIS FENCE ───────────────────────────────────────────────────
// The camera sits at azimuth `iso.rz` = 40°, polar 55° (presets.ts), so a
// vector in the ground plane is scaled by sin(35°) = 0.574 along the camera's
// horizontal look direction and by 1 across it. `mapleLeafGeom` points the
// APEX at local −Z; at yaw θ = LEAF_READ_AXIS the apex is EXACTLY down the
// depth axis, the blade compresses along its stem→apex axis and the five lobe
// tips project onto each other (the blade reads as a smear). Compressed the
// other way it merely narrows and stays a maple.
//
// So the stem→apex azimuth is forbidden from landing within LEAF_YAW_FORBID of
// the depth axis or its opposite. Raising the baked lie instead turns the
// crown into a claw. The worst case the fence admits is a 25° oblique:
// length × 0.670, width × 0.939, a 0.71 aspect distortion.
/** Half-width of the forbidden arc about the camera's depth axis. */
export const LEAF_YAW_FORBID = deg(25)

/** …and what a CLUMP has to add on top of it. A clump's blades carry their own
 * baked in-clump yaw offsets, so the fence has to be widened by the largest
 * offset a clump's rows deviate from {0, π} — see `mapleClumpFence`. The rows
 * are authored near 0 or near π precisely so that widening stays small. */
export const LEAF_CLUMP_YAW_DEV_MAX = deg(20)

export const LEAF_SCATTER: ScatterPose = {
  bias: 0.5,
  forbid: LEAF_YAW_FORBID,
  cantArc: 0.5,
  tilt: [deg(1), deg(2)],
  propShare: 0.18,
  propTilt: [deg(2), deg(3.5)],
}

/** Clearance a re-seated instance keeps above its own contact point, so a
 * tilted blade's down-slope edge can never dip into the surface through float
 * error. Tiny — 0.05 units is 0.012 mm at the desk pencil's 4.1 units/cm. */
const SCATTER_SEAT_EPS = 0.05

/** FNV-1a over the placement's propId — the pose seed. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Successive uniforms in [0,1) — plain 32-bit LCG, deterministic. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** The yaw mapping — a FENCE plus a lean, exported so the gate measures the
 * shipped mapping rather than a copy of it.
 *
 * `u` ∈ [0,1) is split in half: each half fills ONE of the two arcs the fence
 * leaves open, [read + forbid, read + π − forbid] and the same arc rotated by
 * π. Inside an arc the parameter is warped by t + (bias/2π)·sin 2πt, which is
 * strictly increasing for bias < 1 (so every angle in the arc is reachable)
 * and whose derivative is SMALLEST at the arc centre — i.e. the density peaks
 * BROADSIDE, where a fallen blade shows the camera its full width, and thins
 * toward the fence. A warp that peaks on the depth axis instead would
 * concentrate blades at the one azimuth that destroys them. */
export function scatterYaw(u: number, bias: number, forbid: number = LEAF_YAW_FORBID): number {
  const half = u < 0.5 ? 0 : 1
  const t = Math.min(1, Math.max(0, (u - 0.5 * half) * 2))
  const w = t + (bias / (2 * Math.PI)) * Math.sin(2 * Math.PI * t)
  return LEAF_READ_AXIS + forbid + w * (Math.PI - 2 * forbid) + half * Math.PI
}

/** Smallest angle between a blade's stem→apex azimuth and the camera's depth
 * axis (which is LEAF_READ_AXIS, and is its own opposite for this purpose —
 * the ground-plane squash is an AXIS, so θ and θ+π foreshorten identically).
 * The gate reads this; so does nothing else, on purpose. */
export function depthAxisOffset(yaw: number): number {
  const d = Math.abs(((yaw - LEAF_READ_AXIS) % Math.PI) + Math.PI) % Math.PI
  return Math.min(d, Math.PI - d)
}

/** One instance's pose. PURE in `propId`.
 *
 *  • `yaw`  — full circle, warped by `bias`;
 *  • `cant` — the horizontal azimuth the blade's FACE turns toward, inside
 *    ±`cantArc` of LEAF_READ_AXIS;
 *  • `tilt` — how far it turns.
 *
 * The rotation axis follows from the cant: rotating (0,1,0) about a horizontal
 * axis (aₓ, 0, a_z) by t gives (−a_z·sin t, cos t, aₓ·sin t), so a face that
 * must lean toward (sin ψ, 0, cos ψ) needs the axis (cos ψ, 0, −sin ψ). */
export function scatterPoseOf(
  propId: string,
  pose: ScatterPose,
): { yaw: number; cant: number; tilt: number; axis: THREE.Vector3 } {
  const rnd = lcg(hash32(propId))
  const yaw = scatterYaw(rnd(), pose.bias, pose.forbid)
  const cant = LEAF_READ_AXIS + (rnd() - 0.5) * 2 * pose.cantArc
  const range = rnd() < pose.propShare ? pose.propTilt : pose.tilt
  const tilt = range[0] + rnd() * (range[1] - range[0])
  return { yaw, cant, tilt, axis: new THREE.Vector3(Math.cos(cant), 0, -Math.sin(cant)) }
}

/** The desk flag's sheet is the same problem one axis up: a flat UPRIGHT
 * plane, unreadable edge-on. Its normal is local +Z, which after a yaw Y is
 * (sin Y, 0, cos Y) — exactly the direction back toward a camera at azimuth
 * Y, so the same centre serves. The spread is much wider than the leaves'
 * because an upright plane is not compressed by the camera's polar angle:
 * ±0.5 rad only ever costs cos 0.5 = 12% of the sheet's width, and the
 * remaining turn is what stops a deskful of flags reading as one stamp. */
export const FLAG_YAW_BAND = {
  centres: [LEAF_READ_AXIS],
  spread: 0.5,
} as const

/** The index cards' yaw band (desk-note.glb): their text-up axis is local −Z,
 * which a yaw Y turns to (−sin Y, 0, −cos Y) — away from a camera at azimuth
 * Y, i.e. "up" on screen. Same centre as the flag; the spread keeps a desk's
 * cards from reading as one stamp while the writing stays within ±26° of
 * upright. */
export const NOTE_YAW_BAND = {
  centres: [LEAF_READ_AXIS],
  spread: 0.45,
} as const

function bandYaw(rotY: number, band: { centres: readonly number[]; spread: number }): number {
  const TAU = Math.PI * 2
  const u = (((rotY % TAU) + TAU) % TAU) / TAU
  const n = band.centres.length
  const k = Math.min(n - 1, Math.floor(u * n))
  return band.centres[k] + (u * n - k - 0.5) * 2 * band.spread
}

// ── detailed clay models — multi-tone via baked vertex colors, merged ───────
// One geometry per archetype (one draw call as an InstancedMesh); every part
// bakes its clay tint into a vertex-color attribute before the merge, so a
// single vertexColors material carries two-tone people, slotted racks and
// layered trees. Deterministic, dependency-free, and swap-compatible with a
// future GLB pack behind the same archetype ids.

const geomCache = new Map<string, ArchetypeGeom>()

/** Bake a flat color into a part (pre-merge). */
function tint(geo: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const c = new THREE.Color(hex)
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

/** UV a part samples when it has no texture coordinates of its own (contact
 * decals, primitives merged beside an asset blade): the maps' reserved corner,
 * white in the detail map and flat in the normal map — see LEAF_UV in
 * scripts/blender/canadiana_assets.py (the blade lives in [0.06, 0.94]²). */
const NEUTRAL_UV: readonly [number, number] = [0.02, 0.02]

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // mergeGeometries needs ONE attribute set: once any part carries UVs (an
  // asset blade), the others get the neutral corner
  if (parts.some((p) => p.getAttribute('uv'))) {
    for (const p of parts) {
      if (p.getAttribute('uv')) continue
      const n = p.getAttribute('position').count
      const uv = new Float32Array(n * 2)
      for (let i = 0; i < n; i++) {
        uv[i * 2] = NEUTRAL_UV[0]
        uv[i * 2 + 1] = NEUTRAL_UV[1]
      }
      p.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    }
  }
  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return merged
}

/** Clay palette — warm maquette tones shared across packs. */
const CLAY = {
  skin: '#D9C6A8',
  shirtA: '#C96F4A',
  shirtB: '#7E8AA3',
  pants: '#5E574E',
  chassis: '#8A857D',
  slot: '#5C5851',
  accent: '#D97A3D',
  wood: '#B3906A',
  woodDark: '#8F6F4E',
  crate: '#C0A886',
  crateEdge: '#A88E66',
  leafA: '#8FA97E',
  leafB: '#7C9A6C',
  trunk: '#8A6F52',
  pot: '#C9BBA6',
}

type PersonPose = 'standing' | 'standing-b' | 'pointing' | 'pair' | 'walking' | 'carrying'

function personGeom(pose: PersonPose): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  type ArmMode = 'hang' | 'hang-bent' | 'point' | 'swing-f' | 'swing-b' | 'carry'
  const one = (dx: number, shirt: string, lean: number, kind: 'stand' | 'point' | 'walk' | 'carry') => {
    // TWO legs — a single fat cylinder reads as a map-pin base at hero
    // framing. Walking splits them fore/aft at the hip.
    const leg = (side: -1 | 1) => {
      const g = tint(new THREE.CylinderGeometry(1.15, 1.35, 7, 8), CLAY.pants)
      if (kind === 'walk') {
        g.translate(0, -3.5, 0) // pivot at the hip
        g.rotateX(side * 0.42) // side −1 steps forward (+Z), +1 trails
        g.translate(dx + side * 1.35, 6.7, 0)
      } else {
        g.translate(dx + side * 1.35, 3.5, 0)
      }
      parts.push(g)
    }
    leg(-1)
    leg(1)
    const hips = tint(new THREE.CylinderGeometry(2.45, 2.05, 2.6, 10), CLAY.pants)
    hips.translate(dx, 8.2, 0)
    parts.push(hips)
    // torso: shoulders wider than the waist + a flattened shoulder cap — a
    // capsule's rounded top reads as a pin head
    const torso = tint(new THREE.CylinderGeometry(2.85, 2.1, 6.4, 12), shirt)
    torso.rotateZ(lean)
    torso.translate(dx, 12.5, 0)
    parts.push(torso)
    const shoulders = tint(new THREE.SphereGeometry(2.85, 12, 8), shirt)
    shoulders.scale(1, 0.42, 0.85)
    shoulders.translate(dx - Math.sin(lean) * 3.2, 15.7, 0)
    parts.push(shoulders)
    const head = tint(new THREE.SphereGeometry(2.35, 12, 10), CLAY.skin)
    head.translate(dx - Math.sin(lean) * 4.2, 18.1, 0)
    parts.push(head)
    // arms: thin capsules pivoted at the shoulder, ALWAYS angled (a straight
    // T-pose or armless torso both collapse back into the pin read)
    const arm = (side: -1 | 1, mode: ArmMode) => {
      const g = tint(new THREE.CapsuleGeometry(1.0, 5.2, 3, 8), shirt)
      g.translate(0, -3.4, 0) // shoulder pivot at the origin
      switch (mode) {
        case 'hang':
          g.rotateX(0.12) // hint of forward bend
          g.rotateZ(side * 0.22) // hangs slightly away from the torso
          break
        case 'hang-bent':
          g.rotateX(-0.35) // hand toward the hip pocket
          g.rotateZ(side * 0.16)
          break
        case 'point':
          g.rotateX(-1.72) // raised, pointing where the figure faces (+Z)
          g.rotateZ(side * 0.1)
          break
        case 'swing-f':
          g.rotateX(-0.55)
          g.rotateZ(side * 0.12)
          break
        case 'swing-b':
          g.rotateX(0.5)
          g.rotateZ(side * 0.12)
          break
        case 'carry':
          g.rotateX(-1.35) // both forearms forward under the load
          g.rotateZ(side * -0.08) // hands pinch inward on the box
          break
      }
      g.translate(dx + side * 3.15 - Math.sin(lean) * 3.0, 15.3, 0)
      parts.push(g)
    }
    if (kind === 'point') {
      arm(1, 'point')
      arm(-1, 'hang')
    } else if (kind === 'walk') {
      arm(1, 'swing-f') // right arm forward — opposite the forward (left) leg
      arm(-1, 'swing-b')
    } else if (kind === 'carry') {
      arm(1, 'carry')
      arm(-1, 'carry')
      const box = tint(new THREE.BoxGeometry(5.2, 3.6, 3.4), CLAY.crate)
      box.translate(dx, 14.2, 4.3)
      parts.push(box)
      const lid = tint(new THREE.BoxGeometry(5.5, 0.7, 3.7), CLAY.crateEdge)
      lid.translate(dx, 16.2, 4.3)
      parts.push(lid)
    } else {
      arm(1, 'hang')
      arm(-1, 'hang-bent')
    }
  }
  if (pose === 'pair') {
    one(-4.6, CLAY.shirtA, 0.06, 'stand')
    one(4.6, CLAY.shirtB, -0.08, 'stand')
  } else if (pose === 'standing-b') {
    // the B variant (other shirt, other lean) breaks the clone read
    one(0, CLAY.shirtB, -0.05, 'stand')
  } else if (pose === 'walking') {
    one(0, CLAY.shirtA, 0, 'walk')
  } else if (pose === 'carrying') {
    one(0, CLAY.shirtB, 0, 'carry')
  } else {
    one(0, pose === 'pointing' ? CLAY.shirtB : CLAY.shirtA, pose === 'standing' ? 0.03 : 0, pose === 'pointing' ? 'point' : 'stand')
  }
  return mergeParts(parts)
}

function serverRackGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [tint(new THREE.BoxGeometry(16, 25, 10), CLAY.chassis)]
  parts[0].translate(0, 13.5, 0)
  // slot blades on the front face + accent LED strip
  for (let i = 0; i < 5; i++) {
    const blade = tint(new THREE.BoxGeometry(13, 2.2, 0.9), CLAY.slot)
    blade.translate(0, 5.5 + i * 4.2, 5.2)
    parts.push(blade)
  }
  const led = tint(new THREE.BoxGeometry(1.4, 18, 0.5), CLAY.accent)
  led.translate(-6.2, 13.5, 5.3)
  parts.push(led)
  const feet = tint(new THREE.BoxGeometry(17, 1, 11), CLAY.slot)
  feet.translate(0, 0.5, 0)
  parts.push(feet)
  return mergeParts(parts)
}

function cableSpoolGeom(): THREE.BufferGeometry {
  const parts = [
    tint(new THREE.CylinderGeometry(8, 8, 1.8, 18), CLAY.wood),
    tint(new THREE.CylinderGeometry(4.2, 4.2, 7.4, 14), CLAY.woodDark),
    // wound cable — its own deep cocoa, NOT CLAY.accent: the torus is the
    // biggest orange mass in frame and would compete with the UI accent; the
    // rack's LED sliver keeps the accent
    tint(new THREE.TorusGeometry(5.6, 1.5, 8, 20), '#B8663A'),
    tint(new THREE.CylinderGeometry(8, 8, 1.8, 18), CLAY.wood),
  ]
  parts[0].translate(0, 0.9, 0)
  parts[1].translate(0, 5.5, 0)
  parts[2].rotateX(Math.PI / 2)
  parts[2].translate(0, 5.5, 0)
  parts[3].translate(0, 10.1, 0)
  return mergeParts(parts)
}

function crateGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [tint(new THREE.BoxGeometry(13, 10.5, 13), CLAY.crate)]
  parts[0].translate(0, 5.25, 0)
  const lid = tint(new THREE.BoxGeometry(14, 1.4, 14), CLAY.crateEdge)
  lid.translate(0, 11.2, 0)
  parts.push(lid)
  for (const dz of [-6.2, 6.2]) {
    const rib = tint(new THREE.BoxGeometry(14, 1.6, 1.6), CLAY.crateEdge)
    rib.translate(0, 3, dz)
    parts.push(rib)
  }
  return mergeParts(parts)
}

function treeGeom(tall: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const trunk = tint(new THREE.CylinderGeometry(1.5, 2.1, tall ? 10 : 6, 10), CLAY.trunk)
  trunk.translate(0, tall ? 5 : 3, 0)
  parts.push(trunk)
  if (tall) {
    // layered conifer: three cones, darker toward the base
    const tiers: [number, number, number, string][] = [
      [7.2, 8, 11, CLAY.leafB],
      [5.6, 7, 17, CLAY.leafA],
      [3.8, 6.5, 22.5, CLAY.leafB],
    ]
    for (const [r, h, y, col] of tiers) {
      const cone = tint(new THREE.ConeGeometry(r, h, 12), col)
      cone.translate(0, y, 0)
      parts.push(cone)
    }
  } else {
    const crownA = tint(new THREE.SphereGeometry(7.2, 14, 12), CLAY.leafA)
    crownA.translate(0, 11.5, 0)
    const crownB = tint(new THREE.SphereGeometry(4.6, 12, 10), CLAY.leafB)
    crownB.translate(3.4, 14.6, 1.8)
    parts.push(crownA, crownB)
  }
  return mergeParts(parts)
}

function planterGeom(): THREE.BufferGeometry {
  const parts = [
    tint(new THREE.CylinderGeometry(5.2, 4.2, 4.8, 14), CLAY.pot),
    tint(new THREE.TorusGeometry(5, 0.8, 8, 16), CLAY.crateEdge),
    tint(new THREE.SphereGeometry(5.2, 12, 10), CLAY.leafA),
    tint(new THREE.SphereGeometry(3.4, 10, 8), CLAY.leafB),
  ]
  parts[0].translate(0, 2.4, 0)
  parts[1].rotateX(Math.PI / 2)
  parts[1].translate(0, 4.8, 0)
  parts[2].translate(0, 8.2, 0)
  parts[3].translate(2.6, 10.4, 1.4)
  return mergeParts(parts)
}

// ── workbench props (desk zone) — REAL-scale objects beside the maquette ──

/** View3d quality loop 4: "the desk props are 10-20 px specks" at the fit
 * framing (workbench-wide.png: the cable coil a grey ring, the hats barely
 * read). The coil (26 → 36 across) and the ranger hat (40 → 56 brim) grow by
 * this factor; their registry footprints grow with them (registry.ts), so the
 * desk spacing rule still bounds the meshes. The CN tower is not scaled (it
 * is a 124-unit souvenir ornament since quality pass "cntower" — the 281-unit
 * cone dominated the frame). */
export const DESK_PROP_GROWTH = 1.4

/** Move a prop so its plan-view bounding box is centred on the origin. */
function centreXZ(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.computeBoundingBox()
  const b = geo.boundingBox!
  geo.translate(-(b.min.x + b.max.x) / 2, 0, -(b.min.z + b.max.z) / 2)
  return geo
}

function pencilGeom(): THREE.BufferGeometry {
  // lying flat along X: hex barrel, ferrule + eraser at −X, wood cone +
  // graphite tip at +X (a giant pencil next to the miniature buildings)
  const parts: THREE.BufferGeometry[] = []
  const barrel = tint(new THREE.CylinderGeometry(3.4, 3.4, 78, 6), '#D9A648')
  barrel.rotateZ(Math.PI / 2)
  parts.push(barrel)
  const ferrule = tint(new THREE.CylinderGeometry(3.5, 3.5, 5, 12), '#B8B0A4')
  ferrule.rotateZ(Math.PI / 2)
  ferrule.translate(-41.5, 0, 0)
  parts.push(ferrule)
  const eraser = tint(new THREE.CylinderGeometry(3.3, 3.3, 6, 12), CLAY.shirtA)
  eraser.rotateZ(Math.PI / 2)
  eraser.translate(-46.5, 0, 0)
  parts.push(eraser)
  const wood = tint(new THREE.CylinderGeometry(0.01, 3.4, 10, 12), CLAY.skin)
  wood.rotateZ(-Math.PI / 2)
  wood.translate(44, 0, 0)
  parts.push(wood)
  const lead = tint(new THREE.CylinderGeometry(0.01, 1.1, 3.4, 8), '#4A443C')
  lead.rotateZ(-Math.PI / 2)
  lead.translate(50.6, 0, 0)
  parts.push(lead)
  return mergeParts(parts)
}

function cableCoilGeom(): THREE.BufferGeometry {
  // a neatly wound cable coil in warm braided-beige rubber — the board
  // cables' desk-scale cousin. CLOSED loops only: open dark arcs read as a
  // flat opaque scribble on the desk from the iso camera
  const parts: THREE.BufferGeometry[] = []
  const winds: [number, number, number, number, string][] = [
    [13, 0, 0, 0, '#B9A88C'],
    [11.6, 0.9, 1.9, 0.7, '#A79678'],
    [12.3, -0.7, 3.8, -0.5, '#B3A183'],
  ]
  for (const [r, dx, dy, dz, tone] of winds) {
    const loop = tint(new THREE.TorusGeometry(r, 2.3, 8, 22), tone)
    loop.rotateX(Math.PI / 2)
    loop.translate(dx, dy, dz)
    parts.push(loop)
  }
  // SHORT tail hugging the desk into a chunky BOXY plug: a long tapered tail
  // crossing behind the raised rim reads as a swan neck with a dark head
  // from the iso camera; a flat rectangular plug cannot read as a head
  const tail = tint(new THREE.CylinderGeometry(2.1, 2.1, 14, 8), '#B9A88C')
  tail.rotateZ(Math.PI / 2)
  tail.rotateY(0.42)
  tail.translate(18.5, 0, 5.5)
  parts.push(tail)
  const plug = tint(new THREE.BoxGeometry(8, 4.5, 5.5), '#8F8064')
  plug.rotateY(0.42)
  plug.translate(28.5, 0, 1.1)
  parts.push(plug)
  const prongs = tint(new THREE.BoxGeometry(1.8, 2.6, 3.4), '#5C5851')
  prongs.rotateY(0.42)
  prongs.translate(32.9, 0, -0.86)
  parts.push(prongs)
  return mergeParts(parts)
}

/** FALLBACK for desk-mug.glb (scripts/blender/desk_assets.py): the camp
 * mug's silhouette — white enamel body, navy rim, coffee, a D handle at +X —
 * on the asset's gabarit (r 19, 44 tall). No print: the official leaf is
 * the GLB's texture, never redrawn as geometry here. */
function mugGeom(): THREE.BufferGeometry {
  const ENAMEL = '#F2EFE7'
  const NAVY = '#1E2D4C'
  const parts: THREE.BufferGeometry[] = []
  const body = tint(new THREE.CylinderGeometry(19, 18.4, 41.4, 24, 1, true), ENAMEL)
  body.translate(0, 0.6 + 20.7, 0)
  parts.push(body)
  const rim = tint(new THREE.TorusGeometry(18.6, 0.9, 6, 24), NAVY)
  rim.rotateX(Math.PI / 2)
  rim.translate(0, 43.2, 0)
  parts.push(rim)
  const foot = tint(new THREE.CylinderGeometry(18.4, 17, 1.2, 24), NAVY)
  foot.translate(0, 0.6, 0)
  parts.push(foot)
  const coffee = tint(new THREE.CircleGeometry(17.6, 24), '#2B170C')
  coffee.rotateX(-Math.PI / 2)
  coffee.translate(0, 36.5, 0)
  parts.push(coffee)
  const handle = tint(new THREE.TorusGeometry(10.5, 2.3, 6, 12, Math.PI), ENAMEL)
  handle.rotateZ(-Math.PI / 2)
  handle.translate(18, 23, 0)
  parts.push(handle)
  // centred on the plan box like the GLB (the handle side is longer)
  return centreXZ(mergeParts(parts))
}

/** FALLBACK for desk-note.glb (the two index cards with handwriting). */
function deskNoteGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [tint(new THREE.BoxGeometry(34, 0.9, 25), '#F2E7D2')]
  parts[0].translate(0, 0.45, 0)
  for (let i = 0; i < 3; i++) {
    const line = tint(new THREE.BoxGeometry(24 - i * 5, 0.25, 1.6), '#8A8274')
    line.translate(-2 + i * 1.5, 0.95, -6 + i * 6)
    parts.push(line)
  }
  return mergeParts(parts)
}

/** FALLBACK for desk-notebooks.glb (desk_assets.py, loop 4 r2): two pocket
 * notebooks stacked askew with a pen across, on the asset's gabarit (54 x 34
 * covers, 5 thick, plan radius 32.5). */
function notebooksGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const lower = tint(new THREE.BoxGeometry(54, 5, 34), '#2F5A45')
  lower.rotateY(0.12)
  lower.translate(-1, 2.5, 0)
  parts.push(lower)
  const upper = tint(new THREE.BoxGeometry(54, 5, 34), '#7C2A23')
  upper.rotateY(-0.16)
  upper.translate(1, 7.5, -1)
  parts.push(upper)
  const pen = tint(new THREE.CylinderGeometry(1.55, 1.55, 50, 8), '#1F3766')
  pen.rotateZ(Math.PI / 2)
  pen.rotateY(0.42)
  pen.translate(-1, 11.6, 1.5)
  parts.push(pen)
  return mergeParts(parts)
}

/** FALLBACK for desk-plant.glb: a terracotta pot with a sheaf of upright
 * green blades (pot r 14.6, ~75 tall as the asset). */
function plantGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const pot = tint(new THREE.CylinderGeometry(14.4, 10.6, 24, 16), '#B5623A')
  pot.translate(0, 12, 0)
  parts.push(pot)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    const blade = tint(new THREE.ConeGeometry(2.4, 34 + (i % 3) * 8, 4), '#2C5634')
    blade.scale(1, 1, 0.35)
    blade.rotateZ(0.16 * Math.cos(a))
    blade.rotateX(0.16 * Math.sin(a))
    blade.translate(3 * Math.cos(a), 24 + (34 + (i % 3) * 8) / 2, 3 * Math.sin(a))
    parts.push(blade)
  }
  return mergeParts(parts)
}

/** FALLBACK for desk-pencil-cup.glb (desk_assets.py, loop 4 r3): a walnut
 * cup (r 15, 40 tall) holding four splayed pencils, on the asset's gabarit
 * (plan radius 18.4, 82.5 tall). */
function pencilCupGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const cup = tint(new THREE.CylinderGeometry(15, 14.4, 40, 16), '#6A4329')
  cup.translate(0, 20, 0)
  parts.push(cup)
  const tones = ['#E8B53A', '#C8402F', '#2F5A9A', '#3F7A4A']
  for (let i = 0; i < tones.length; i++) {
    const a = (i / tones.length) * Math.PI * 2 + 0.3
    const pencil = tint(new THREE.CylinderGeometry(1.9, 1.9, 74, 6), tones[i])
    pencil.translate(0, 37, 0)
    pencil.rotateZ(0.18)
    pencil.rotateY(a)
    pencil.translate(3 * Math.cos(a), 6, 3 * Math.sin(a))
    parts.push(pencil)
  }
  return centreXZ(mergeParts(parts))
}

/** FALLBACK for desk-books.glb (desk_assets.py, loop 4 r3): three small
 * hardbacks stacked askew (58 x 38 at the bottom, 21 tall; plan radius 36). */
function booksGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const books: [number, number, number, number, string][] = [
    [58, 38, 8, 0, '#22385E'],
    [54, 36, 7, 0.12, '#B07C2A'],
    [50, 33, 6.2, -0.1, '#7A2A26'],
  ]
  let y = 0
  for (const [w, d, t, yaw, tone] of books) {
    const b = tint(new THREE.BoxGeometry(w, t, d), tone)
    b.rotateY(yaw)
    b.translate(0, y + t / 2, 0)
    parts.push(b)
    y += t
  }
  return centreXZ(mergeParts(parts))
}

/** FALLBACK for desk-sketchbook.glb (desk_assets.py, loop 4 r4): an A6
 * spiral sketchbook lying open — two cream page blocks on black boards and a
 * green pencil across, on the asset's gabarit (88.8 x 62, plan radius 54.2,
 * 4.7 tall). */
function sketchbookGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (const side of [-1, 1]) {
    const cover = tint(new THREE.BoxGeometry(44.4, 0.6, 62), '#2A2B2F')
    cover.translate(side * 22.2, 0.3, 0)
    parts.push(cover)
    const t = side < 0 ? 1.3 : 2.1
    const pages = tint(new THREE.BoxGeometry(42, t, 60), '#F4EFE3')
    pages.translate(side * 22.4, 0.6 + t / 2, 0)
    parts.push(pages)
  }
  const pencil = tint(new THREE.CylinderGeometry(1.15, 1.15, 50, 6), '#2F6B45')
  pencil.rotateX(Math.PI / 2)
  pencil.rotateY(0.59)
  pencil.translate(25, 3.7, -4)
  parts.push(pencil)
  return centreXZ(mergeParts(parts))
}

/** FALLBACK for desk-blueprint.glb (desk_assets.py, loop 4 r4): a blueprint
 * sheet half unrolled from its roll (92 across, plan radius 53, 12.4 tall). */
function blueprintGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const sheet = tint(new THREE.BoxGeometry(46, 0.3, 92), '#1F4E8E')
  sheet.translate(23, 0.15, 0)
  parts.push(sheet)
  const roll = tint(new THREE.CylinderGeometry(5.4, 5.4, 92, 14), '#E6E3D8')
  roll.rotateX(Math.PI / 2)
  roll.translate(0, 5.4, 0)
  parts.push(roll)
  return centreXZ(mergeParts(parts))
}

// ── canadiana pack — desk-scale Canadiana miniatures (ref1: moose, beaver,
// loon, ranger hats, red maple leaves, CN tower on the wood around the
// board; ref2: compass + scalpel desk tools at the edges) ──────────────────


// ── THE MAPLE — LOBE HIERARCHY, not a starburst ────────────────────────────
//
// At the 45-70 px a blade is delivered at, an outline whose points are all
// roughly the same length reads as a starburst. A maple reads because its
// parts are UNEQUAL:
//
//     one central lobe   r = 1.000   — the tall one, and it must have a BODY
//     two lateral lobes  r = 0.850   — the wide ones
//     two basal lobes    r = 0.600   — the small ones
//     four sinuses       r = 0.405-0.430
//     six teeth          ≤ 0.092 deep, i.e. under a fifth of a sinus
//
// Every one of those numbers is gated in build.test.ts against the SHIPPED
// array. The hierarchy is the read; the vertex count (37) is just what the
// hierarchy costs.
//
// THE BODY IS A VERTEX. The single change that turns a spike into a lobe is the
// CROWN SHOULDER at (0.232, 0.700): it makes the central lobe 0.464 of the apex
// radius wide at its own mid-height. Without it the same five tips at the same
// five radii deliver a starfish.
//
// TEETH ARE CAPPED, HARD. Once a tooth approaches the depth of a sinus the eye
// stops being able to tell which cut separates lobes. Three teeth per side, the
// deepest 0.092 of the apex radius against the shallowest sinus at 0.405 — a
// 4.4× separation. The shortest edge is 0.049 units = 6.7% of the blade radius.
//
// THE STEM IS A QUAD: 0.150 of the apex radius long, 0.052 wide, constant
// width. It is the cheapest cue that this is a leaf and not a splat, and it
// survives to about 30 px.
//
// The outline is drawn HALF and mirrored, so the two sides can never drift; and
// every segment is a straight `lineTo`, because a maple silhouette is POINTS.
// 1.250 wide × 1.225 tall — the reference's own near-square blade.
const MAPLE_HALF: readonly (readonly [number, number])[] = [
  // ── LOBE 1 — the CENTRAL lobe. Apex at r = 1.000 by definition; every other
  //    radius on the blade is quoted against it.
  [0.0, 1.0], //        central apex                              LOBE 1 tip
  [0.1042, 0.825], //   crown tooth — notch (0.052 deep: a TOOTH)
  [0.2032, 0.7859], //  crown tooth — point
  [0.24, 0.7], //       CROWN SHOULDER — the mass. Full width here is 0.479 of
  //                    the apex radius, at the central lobe's own mid-height:
  //                    this single vertex is the difference between a lobe and
  //                    a spike, and build.test.ts measures it.
  // ── SINUS 1 (central ↔ lateral) — floor at r = 0.430, ROUNDED over three
  //    points spanning ~0.09 of the radius. Deep enough to cut the lobes apart,
  //    shallow enough to leave a body between them.
  [0.128, 0.4377], //   sinus 1 — in
  [0.1611, 0.3987], //  sinus 1 — FLOOR (r = 0.430)
  [0.212, 0.4037], //   sinus 1 — out
  // ── LOBE 2 — the LATERAL lobe, r = 0.850. Two teeth, no more: one on the
  //    upper margin, one lower point on the way back into sinus 2. Both are
  //    under 0.10 of the radius deep, so neither can be mistaken for a sinus.
  [0.395, 0.4303], //   lateral upper tooth — notch
  [0.492, 0.5533], //   lateral upper tooth — point
  [0.625, 0.5761], //   LATERAL TIP                               LOBE 2 tip
  [0.48, 0.335], //     lateral lower tooth — notch (0.092 deep)
  [0.56, 0.25], //      lateral lower tooth — point
  // ── SINUS 2 (lateral ↔ basal) — floor at r = 0.405, rounded the same way.
  [0.3914, 0.1721], // sinus 2 — in
  [0.3852, 0.1252], // sinus 2 — FLOOR (r = 0.405)
  [0.4177, 0.0909], // sinus 2 — out
  // ── LOBE 3 — the BASAL lobe, r = 0.600, pointing out and a shade down.
  [0.6, -0.021], //     BASAL TIP                                 LOBE 3 tip
  [0.255, -0.135], //   cordate base dip — the blade's own bottom edge, which
  //                    is what stops the two basal lobes reading as one skirt
  // ── THE STEM. A QUAD, not a taper: 0.150 of the apex radius long and 0.052
  //    wide, constant. Short and blunt is what reads at 45 px; a tapered
  //    spike vanishes into the blade.
  [0.026, -0.075], //   blade ↔ stem
  [0.026, -0.225], //   stem foot
]

/** The mirrored outline — 37 vertices, 5 lobes, 4 sinuses, 3 teeth per side.
 * The stem foot is NOT axial, so the mirror closes the stem into a proper quad
 * across the axis; the filter only ever drops an exact repeat. */
export const MAPLE_LEAF_OUTLINE: readonly (readonly [number, number])[] = [
  ...MAPLE_HALF,
  ...MAPLE_HALF.slice(1)
    .reverse()
    .map(([x, y]) => [-x, y] as const),
].filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1e-9)

/** THE FLAG EMBLEM — a SEPARATE, THREE-lobe stencil.
 *
 * One polygon cannot be legible at two scales that differ by 4×: the blade is
 * delivered at 45-75 px and wants its five lobes; the emblem is delivered at
 * 12-20 px on a 25-unit white band, where an eleven-point outline is stipple.
 * So the emblem is authored from the SAME lobe skeleton with everything that
 * cannot survive 16 px removed (basal lobes, teeth, rounded sinus floors). Both
 * outlines are gated against the exported arrays, so they cannot drift.
 *
 * To read as a maple and not a trident / fleur-de-lis:
 *  • the lateral tips sit low ([0.60, 0.42]) so the central lobe is 2.4× the
 *    lateral's height above the sinus line and clearly dominates;
 *  • the sinus floor at [0.2205, 0.2718] (r = 0.350) is low and wide, so the
 *    shape does not pinch to a neck where the laterals attach;
 *  • a body shoulder at [0.30, 0.02] and a wide foot give the lower half a
 *    trapezoid the three points sit on;
 *  • a constant-width stem quad on the bottom silhouette — the one cue that
 *    separates a maple from a fleur-de-lis, and still a visible tick at 1-2 px.
 *
 * 9 half-vertices / 17 total, 4 reflex (two sinuses, two stem shoulders),
 * solidity 0.67. */
const FLAG_EMBLEM_HALF: readonly (readonly [number, number])[] = [
  [0.0, 1.0], //        central spike — the apex, r = 1.000 by definition
  [0.185, 0.575], //    crown shoulder — the central lobe's own body. Low and
  //                    narrow on purpose: higher and wider, the lobe's sides
  //                    run parallel and the spike reads as a bud on a stalk.
  [0.2205, 0.2718], //  SINUS — FLOOR at r = 0.350 exactly, no rounding
  [0.6, 0.42], //       LATERAL TIP — lowered, so the central spike dominates
  [0.42, 0.13], //      lateral lower margin
  [0.3, 0.02], //       BODY SHOULDER — the mass that replaces the waist
  [0.22, -0.05], //     foot corner
  [0.055, -0.05], //    stem shoulder
  [0.055, -0.26], //    stem foot (not axial — the mirror closes the quad)
]

export const FLAG_EMBLEM_OUTLINE: readonly (readonly [number, number])[] = [
  ...FLAG_EMBLEM_HALF,
  ...FLAG_EMBLEM_HALF.slice(1)
    .reverse()
    .map(([x, y]) => [-x, y] as const),
]

const EMBLEM_YS = FLAG_EMBLEM_OUTLINE.map(([, y]) => y)
export const EMBLEM_W = 2 * Math.max(...FLAG_EMBLEM_OUTLINE.map(([x]) => Math.abs(x)))
export const EMBLEM_H = Math.max(...EMBLEM_YS) - Math.min(...EMBLEM_YS)
const EMBLEM_MID_Y = (Math.max(...EMBLEM_YS) + Math.min(...EMBLEM_YS)) / 2

const LEAF_YS = MAPLE_LEAF_OUTLINE.map(([, y]) => y)
/** Outline extents per unit of `size`. */
export const LEAF_W = 2 * Math.max(...MAPLE_LEAF_OUTLINE.map(([x]) => Math.abs(x)))
export const LEAF_H = Math.max(...LEAF_YS) - Math.min(...LEAF_YS)
/** Mid-height of the outline — `mapleLeafShape` subtracts it so the leaf's own
 * centre, not its stem shoulder, is the origin. That is what makes the registry
 * footprints honest and keeps a yawed board leaf inside the slab's 30-unit
 * open-band clearance. */
const LEAF_MID_Y = (Math.max(...LEAF_YS) + Math.min(...LEAF_YS)) / 2
/** Rotation-safe radius per unit of `size`, about that centre origin — the
 * number every leaf footprint in the registry is derived from. */
export const LEAF_RADIUS = Math.max(...MAPLE_LEAF_OUTLINE.map(([x, y]) => Math.hypot(x, y - LEAF_MID_Y)))

// ── TONE: the break is allocated BY SURFACE, not by chance ─────────────────
//
// A palette is not a property of a leaf; it is a property of a leaf ON
// something. So there are two mixes, chosen by the archetype's ZONE:
//
//   • BOARD (walnut / paper, a mid-warm value) — 40% deep crimson, 30% burnt
//     orange, 20% PALE AMBER, 10% dark brown. The amber is the only tone
//     lighter than walnut, so it is the one that pops.
//   • DESK (a beige workbench, a light value) — see LEAF_TONE_MIX_DESK; amber
//     is kept but darkened there (LEAF_SURFACE_L) so it is not isoluminant
//     with the bench.
//
// And SATURATION varies too, not just hue: one blade in four is flagged MUTED
// and comes out desaturated and browned, so a drift reads as leaves at
// different stages of drying rather than as a swatch strip. The flag is
// declared per blade (LEAF_BLADES) rather than hashed, so the share that ships
// is the share the gate measures.
//
// Inside ONE blade the variation is a VERTICAL RAMP — deep at the petiole,
// bright at the apex — and nothing else. It is a monotone function of a single
// coordinate, so it has no spatial frequency to alias with, cannot touch the
// outline, and cannot produce the fan wedges a per-triangle treatment would.

/** sRGB hex ↔ HSL, plainly, so the tone derivations are documented arithmetic
 * the gate can re-derive rather than a dozen hand-picked hexes that drift apart
 * the first time somebody retunes the palette. (THREE.Color holds the
 * WORKING/linear space, so its own getHSL would answer a different question —
 * this one is about the sRGB values a painter would name.) */
function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  const d = mx - mn
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : mx === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6
  return [h, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 1) + 1) % 1
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hh * 6) % 2) - 1))
  const m = l - c / 2
  const k = Math.floor(hh * 6) % 6
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][k < 0 ? k + 6 : k]
  const q = (v: number): string =>
    Math.round(Math.min(255, Math.max(0, (v + m) * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${q(r)}${q(g)}${q(b)}`
}

/** One blade's colours. `base` is the petiole end, `tip` the apex end, `rim`
 * the extrusion wall. */
interface LeafTone {
  base: string
  tip: string
  rim: string
}

export type LeafToneName = 'scarlet' | 'vermillion' | 'amber' | 'ochre'

/** The FOUR breaks — deep crimson, burnt orange, PALE amber, dark brown. Named
 * on purpose: a reader can check the render against the word. The flag's own
 * #D80621 is NOT here — a pillar-box red is a heraldic red and a drift of them
 * on tan wood read as confetti. */
export const LEAF_PALETTE: Record<LeafToneName, string> = {
  // VIEW3D QUALITY LOOP 3 r2 — "the salmon leaf is washed-out pink, the brown
  // leaf grey-brown and dull" (workbench-leaf.png): the critique's saturated
  // autumn set is crimson #B3261E, orange #D9731A, gold #C9A227, rust #8A3B1C.
  // Crimson, orange and rust are taken as given. Gold is not: at l 0.47 it is
  // DARKER than walnut (0.455 + the 0.05 this palette's value gate requires),
  // and a gold on walnut is the isoluminant blob the amber break exists to
  // avoid — so amber keeps its value and only moves toward the critique's hue.
  // (Most of the "washed-out" was not the palette: the blade's 0.55 roughness
  // mirrored the key toward the iso camera — the asset is 0.72 now.)
  scarlet: '#B3261E',
  vermillion: '#D9731A',
  amber: '#E3A93C',
  // #6E4223 until 2026-10-08: under the city's low dusk key the delivered
  // blade went near-black — a burnt leaf, not a brown one (loop1 city-leaf
  // critique). Lifted to a russet brown, still the darkest break (l 0.357 vs
  // walnut 0.455; the build.test palette gate wants < 0.405). Not the
  // critique's #8A5A2B: at hue 30° its tip sat 5.8° / 0.028 luma from the
  // DESK-darkened amber and the four desk breaks collapsed to three (the
  // desk-distinctness gate caught it); hue 22° keeps them four.
  // Loop 3 r2: the critique's RUST #8A3B1C (hue 17°, s 0.66 vs 0.54): the
  // muted variant of #8C4E2A desaturated to the "grey-brown" it named.
  ochre: '#8A3B1C',
}

/** Which surface a leaf archetype lands on. The tone mix follows from it. */
export type LeafSurface = 'board' | 'desk'

/** The BOARD mix — walnut/paper. The pale amber is the tone that pops here. */
export const LEAF_TONE_MIX_BOARD: Partial<Record<LeafToneName, number>> = {
  scarlet: 0.4,
  vermillion: 0.3,
  amber: 0.2,
  ochre: 0.1,
}
/** The DESK mix — beige bench, FOUR breaks. A two-tone crimson/brown mix
 * reads as dark specks on beige and would break LEAF_DARK_SHARE_MAX. Amber is
 * near-isoluminant with the workbench, and the answer to "two colours share a
 * VALUE" is a value break, not the deletion of a hue: amber stays at 15% and
 * is darkened on this surface only (LEAF_SURFACE_L), buying a 1.35× value
 * break against the bench. */
export const LEAF_TONE_MIX_DESK: Partial<Record<LeafToneName, number>> = {
  scarlet: 0.35,
  vermillion: 0.3,
  amber: 0.15,
  ochre: 0.2,
}
export const LEAF_TONE_MIX: Record<LeafSurface, Partial<Record<LeafToneName, number>>> = {
  board: LEAF_TONE_MIX_BOARD,
  desk: LEAF_TONE_MIX_DESK,
}

/** Per-blade hue jitter, DEGREES, hard-capped: past roughly ten degrees the
 * named breaks stop being breaks and start being a continuum. */
export const LEAF_HUE_JITTER_MAX = 4

/** PER-SURFACE LIGHTNESS BIAS. A tone's job is to separate from
 * the surface it lies ON, so one palette entry may need a different VALUE on
 * walnut than on a beige bench. Amber is the only entry that needs it: it is
 * authored light (that is what makes it pop on walnut) and the workbench is
 * light too. Darkening it on the desk keeps the hue and buys a value break.
 *
 * This is a bias, not a second palette: the hue and saturation are untouched,
 * so the four breaks stay the same four breaks everywhere.
 *
 * The factor is 0.58 because of the BASE→TIP RAMP: `leafTone` lightens the
 * apex by ×1.30 under a 0.66 ceiling, and the ceiling is what sets a light
 * tone's delivered value. At 0.78 the lightest end still lands within 12% of
 * the bench's luminance; 0.58 lands the tip at ≈ #A47A1B, 24% darker than the
 * workbench. The bias therefore scales the tip CEILING too. */
export const LEAF_SURFACE_L: Record<LeafSurface, Partial<Record<LeafToneName, number>>> = {
  board: {},
  desk: { amber: 0.58 },
}

/** Share of blades flagged MUTED — desaturated and browned, so the drift is not
 * a swatch strip. Declared per blade in LEAF_BLADES, gated to this ±0.10. */
export const LEAF_MUTED_SHARE = 0.25
/** …and what the flag does: saturation × this, hue pushed toward ochre. */
const MUTED_SAT = 0.6
/** …except on OCHRE: it is already the darkest, least saturated entry, and
 * 0.60 × its saturation on top of × 0.92 lightness turns it into mud. 0.78
 * keeps the muted ochre a brown LEAF. */
const MUTED_SAT_BY_TONE: Partial<Record<LeafToneName, number>> = { ochre: 0.78 }
const MUTED_HUE_DEG = 7

/** THE RIM IS A LIT SURFACE, NOT A BACKFACE.
 *
 * The extrusion wall's normal is horizontal, facing away from a 38°-elevation
 * key, so a strong darkening (e.g. 0.55 × albedo) lands almost black and reads
 * as a BLACK CRACK where two blades overlap. 0.88 keeps the wall a shade under
 * the lid (so an edge is still an edge) while leaving it the same material lit
 * by the same sun. THREE.Color holds the WORKING (linear) space, so the factor
 * lands where a physical albedo drop belongs. */
function rimOf(hex: string): string {
  const c = new THREE.Color(hex)
  return `#${new THREE.Color(c.r * 0.88, c.g * 0.88, c.b * 0.88).getHexString()}`
}

/** Derive one blade's tone from a palette entry and a deterministic seed.
 *
 * base = the palette hue, one notch redder, at 0.80 of its lightness;
 * tip  = the palette hue pushed 5° toward ochre, at 1.30 of its lightness.
 *
 * That is a 1.63× luminance ramp from petiole to apex — the "base crimson →
 * tip vermilion" break, wide enough to see at 60 px (1.2× is invisible).
 * The hue jitter is bounded by
 * LEAF_HUE_JITTER_MAX and drawn from `seed`, so two scarlet blades in one
 * clump are not the same scarlet and the whole thing stays deterministic. */
export function leafTone(name: LeafToneName, seed: string, muted = false, surface: LeafSurface = 'board'): LeafTone {
  const [h0, s0, l0] = hexToHsl(LEAF_PALETTE[name])
  const h = muted ? h0 + MUTED_HUE_DEG / 360 : h0
  const s = muted ? s0 * (MUTED_SAT_BY_TONE[name] ?? MUTED_SAT) : s0
  const bias = LEAF_SURFACE_L[surface][name] ?? 1
  const l = (muted ? l0 * 0.92 : l0) * bias
  const jitter = ((lcg(hash32(seed))() - 0.5) * 2 * LEAF_HUE_JITTER_MAX) / 360
  const base = hslToHex(h + jitter - 0.006, Math.min(1, s * 1.06), l * 0.8)
  // the CEILING carries the surface bias too — for a light tone the ceiling is
  // what sets the delivered value, so a bias that skipped it would be spent
  // before it reached the pixel (see LEAF_SURFACE_L)
  const tip = hslToHex(h + jitter + 5 / 360, s * 0.94, Math.min(0.66 * bias, l * 1.3))
  return { base, tip, rim: rimOf(base) }
}

/** The dark end of the break is a SEASONING, never the theme: an ochre-brown
 * blade sits within a few values of the dark wood grain and goes plain brown at
 * 70 px, so no more than a quarter of a surface's supply may be one. The cap
 * applies to BOTH surfaces — on the light bench a dark brown is a near-black
 * speck that reads as dirt. Gated per surface. */
export const LEAF_DARK_TONE: LeafToneName = 'ochre'
export const LEAF_DARK_SHARE_MAX = 0.25

/** The flag's heraldic red — NOT a leaf tone. */
export const FLAG_RED = '#D80621'

function shapeOf(outline: readonly (readonly [number, number])[], midY: number, size: number): THREE.Shape {
  const shape = new THREE.Shape()
  outline.forEach(([x, y], i) => {
    const px = x * size
    const py = (y - midY) * size
    if (i === 0) shape.moveTo(px, py)
    else shape.lineTo(px, py)
  })
  shape.closePath()
  return shape
}

const mapleLeafShape = (size: number): THREE.Shape => shapeOf(MAPLE_LEAF_OUTLINE, LEAF_MID_Y, size)
const flagEmblemShape = (size: number): THREE.Shape => shapeOf(FLAG_EMBLEM_OUTLINE, EMBLEM_MID_Y, size)

/** Leaf thickness — 1.5% of the blade's own RADIUS, not of its width:
 *
 *  • a fat die-cut, where two blades overlap, shows a wall tall enough to read
 *    as a seam. Thin + lit (see `rimOf`) removes the seam;
 *  • the wall is the one part of the prop whose normal points away from the
 *    key, so every unit of it is a unit of the darkest value on the blade.
 *
 * No BEVEL: at ~0.38 units thick a 15% bevel would be 0.06 units — far under a
 * pixel — while costing 148 of the 292 triangles a blade spends. */
export const LEAF_THICK_FRAC = 0.015 * LEAF_RADIUS
/** Total die-cut thickness of a leaf. */
function leafThickness(size: number): number {
  return LEAF_THICK_FRAC * size
}

function leafExtrude(size: number): THREE.ExtrudeGeometryOptions {
  return { depth: LEAF_THICK_FRAC * size, bevelEnabled: false, curveSegments: 1 }
}

/** The blade's own tinting: the walls take `rim`, and each LID vertex is a lerp
 * from `base` at the petiole end to `tip` at the apex, by the shape's own Y.
 *
 * It is SHADING, never relief — the outline is untouched (anti-noise law) — and
 * because the ramp is a monotone function of ONE coordinate it has no spatial
 * frequency to stipple with at any delivered size. Run BEFORE the rotation,
 * while the shape still lies in local XY.
 *
 * The colour attribute is RGB**A** (itemSize 4). Blades are opaque (α = 1); the
 * alpha channel exists for the CONTACT SHADOW decal merged into the same
 * geometry, which is the only way to have a soft shadow and still ship one draw
 * call per archetype — see `contactShadowGeom`. THREE turns on USE_COLOR_ALPHA
 * automatically when the attribute has four components. */
function tintLeafGroups(geo: THREE.BufferGeometry, size: number, tone: LeafTone): THREE.BufferGeometry {
  const pos = geo.getAttribute('position')
  const count = pos.count
  const colors = new Float32Array(count * 4)
  const tipC = new THREE.Color(tone.tip)
  const baseC = new THREE.Color(tone.base)
  const rimC = new THREE.Color(tone.rim)
  for (let i = 0; i < count; i++) {
    colors[i * 4] = rimC.r
    colors[i * 4 + 1] = rimC.g
    colors[i * 4 + 2] = rimC.b
    colors[i * 4 + 3] = 1
  }
  const y0 = (Math.min(...LEAF_YS) - LEAF_MID_Y) * size
  const span = LEAF_H * size
  for (const g of geo.groups) {
    if (g.materialIndex !== 0) continue
    for (let i = g.start; i < Math.min(count, g.start + g.count); i++) {
      const u = Math.min(1, Math.max(0, (pos.getY(i) - y0) / span))
      colors[i * 4] = baseC.r + (tipC.r - baseC.r) * u
      colors[i * 4 + 1] = baseC.g + (tipC.g - baseC.g) * u
      colors[i * 4 + 2] = baseC.b + (tipC.b - baseC.b) * u
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 4))
  return geo
}

// ── THE CONTACT SHADOW ────────────────────────────────────────────────────
//
// Without grounding, flat leaves read as decals printed on the wood grain.
// The shadow map cannot provide it: the sun's `normalBias = 1.5` world units
// (lit/lighting.ts) means a receiver samples the shadow map 1.5 units along its
// own normal, so a 0.4-unit-thick leaf lying under that line is not between the
// sample point and the sun. No seat height lets a flat blade cast without also
// visibly hovering.
//
// So the shadow is DRAWN, not sampled: a radial-gradient alpha decal, 1.15× the
// blade's own radius, offset along the key-light vector by the blade's height,
// α 0.22 at the centre falling to 0 at the rim. It is merged into the SAME
// archetype geometry as the blades, so it costs no extra draw call, it survives
// every LOD (it is geometry, not a shadow-map sample), and it is deterministic.
//
// Two consequences are deliberate:
//
//  • the leaf material goes `transparent` with `depthWrite: false`. depthWrite
//    MUST be off: the decal's rim is α = 0 but still rasterises, and with depth
//    writes on it would punch invisible holes in whatever is drawn behind it.
//    Blades are α = 1, so with writes off they simply paint in merge order —
//    and the merge order inside a clump IS the stacking order, bottom blade
//    first, which is the order that reads correctly;
//  • the leaf archetypes stop casting into the shadow map (`castsShadow:
//    false`). They were contributing nothing (see above) and a hard-edged
//    silhouette of a flat DISC is exactly what a drawn contact shadow must not
//    be doubled by.

/** Sun direction, from lit/lighting.ts (azimuth −55°, elevation 38°). A point
 * at height h lands its shadow at h × this, in the ground plane. */
const SUN_AZ = (-55 * Math.PI) / 180
const SUN_EL = (38 * Math.PI) / 180
export const LEAF_SHADOW_PER_HEIGHT: readonly [number, number] = [
  -Math.sin(SUN_AZ) / Math.tan(SUN_EL),
  -Math.cos(SUN_AZ) / Math.tan(SUN_EL),
]
/** Decal radius, as a multiple of the blade's rotation-safe radius. 1.15 →
 * 1.2 in the contact pass, with the smaller LEAF_SHADOW_OFFSET: the pool's
 * near rim has to reach PAST the near lobe tips again. */
export const LEAF_SHADOW_R = 1.2
/** Alpha at the decal's centre — and, from the contact pass (2026-10-09), on
 * its whole plateau out to LEAF_SHADOW_KNEE.
 *
 * Round 4 shipped 0.22 with α = 0.22·(1 − f)^1.6: by f = 0.6 that is 0.05,
 * and the blade's lobe tips sit at f ≈ 0.87 of the decal — so every visible
 * bit of the pool (the sinuses, the rim past the tips) was under 4% and the
 * close-up showed no shadow at all (final-assets/workbench-leaf.png, the
 * critic: "leaves look like decals"). The plateau keeps the dark INSIDE the
 * lobes' reach, where the sinuses show it, and the ramp spends itself in the
 * outer half of the radius, past the tips.
 *
 * Measured in the app (.probes/contact/decal-diff.png: the frame with every
 * decal α forced to 0, subtracted): at 0.38 the pool darkened the desk by at
 * most 25 of 255 levels, mean 11 — the decal shares the blade's glossy lit
 * material, so its black film still carries the sheen. Hence 0.5. */
export const LEAF_SHADOW_ALPHA = 0.5
/** Fraction of the decal radius that stays at LEAF_SHADOW_ALPHA. */
export const LEAF_SHADOW_KNEE = 0.5

/** THE OFFSET, as a multiple of the blade's own radius.
 *
 * The height throw alone (h × LEAF_SHADOW_PER_HEIGHT) is ~1.8 units for a lone
 * blade at mean height ~1.4, under a 29-unit disc — concentric, i.e. entirely
 * hidden UNDER the opaque blade. 0.35 of the blade radius puts the pool's near rim 1.5 R out on the sun's far
 * side and tucks it 0.8 R under on the near side: at the 30-50 px a single is
 * delivered at that is 2-3 px of visible shadow — enough to read as contact,
 * far too little to become a second silhouette competing with the blade.
 *
 * CONTACT PASS (2026-10-09): 0.35 → 0.22. The round-5 pool fell off as
 * (1 − f)^1.6, so it HAD to be pushed out to show at all — and the price was
 * a near rim tucked 0.8 R under the blade: the decal-diff probe showed the
 * darkening entirely behind the leaf, none at its near lobes, i.e. a cast
 * shadow, not a contact one. With the plateau ramp (LEAF_SHADOW_KNEE) a
 * nearly concentric pool shows in every sinus, so the slide only has to lean
 * it: near rim (1.2 − 0.22) R ≈ the near tips, far rim 1.42 R out. */
export const LEAF_SHADOW_OFFSET = 0.22
/** …and the same, for how far the pool slides toward the blade's LOW edge when
 * the die-cut is rolled about its stem→crown axis (see LEAF_ROLL_MAX). A
 * rolled blade touches down on one edge; the shadow has to touch down there
 * too, or the raised edge reads as floating. */
export const LEAF_SHADOW_ROLL = 0.4
/** Unit vector of the sun's ground-plane azimuth. */
const SUN_XZ: readonly [number, number] = (() => {
  const m = Math.hypot(LEAF_SHADOW_PER_HEIGHT[0], LEAF_SHADOW_PER_HEIGHT[1])
  return [LEAF_SHADOW_PER_HEIGHT[0] / m, LEAF_SHADOW_PER_HEIGHT[1] / m]
})()
/** Ring radii (fractions of the decal radius): vertex colours interpolate
 * linearly, so the smoothstep ramp past LEAF_SHADOW_KNEE needs a few rings to
 * stay smooth. */
const SHADOW_RINGS = [0.45, 0.68, 0.86, 1] as const
const SHADOW_SEGS = 12

/** One blade's grounding decal: a flat fan in the XZ plane at y = 0, black with
 * a radial alpha ramp. `h` is the blade's mean height above the surface and
 * `roll` its rotation about the stem→crown axis — both only set the in-plane
 * offset, never the decal's own height. */
function contactShadowGeom(radius: number, h: number, roll = 0): THREE.BufferGeometry {
  const R = radius * LEAF_SHADOW_R
  const rings = SHADOW_RINGS.length
  const pos: number[] = [0, 0, 0]
  const col: number[] = [0, 0, 0, LEAF_SHADOW_ALPHA]
  for (const f of SHADOW_RINGS) {
    // α falls smoothly to exactly 0 at the rim — a hard-edged disc is the one
    // thing a soft contact shadow must never be
    const t = Math.max(0, (f - LEAF_SHADOW_KNEE) / (1 - LEAF_SHADOW_KNEE))
    const a = LEAF_SHADOW_ALPHA * (1 - t * t * (3 - 2 * t))
    for (let s = 0; s < SHADOW_SEGS; s++) {
      const th = (s / SHADOW_SEGS) * Math.PI * 2
      pos.push(Math.cos(th) * R * f, 0, Math.sin(th) * R * f)
      col.push(0, 0, 0, a)
    }
  }
  const idx: number[] = []
  for (let s = 0; s < SHADOW_SEGS; s++) {
    const n = (s + 1) % SHADOW_SEGS
    idx.push(0, 1 + n, 1 + s)
    for (let r = 0; r < rings - 1; r++) {
      const a0 = 1 + r * SHADOW_SEGS + s
      const a1 = 1 + r * SHADOW_SEGS + n
      const b0 = 1 + (r + 1) * SHADOW_SEGS + s
      const b1 = 1 + (r + 1) * SHADOW_SEGS + n
      idx.push(a0, a1, b1, a0, b1, b0)
    }
  }
  const n = pos.length / 3
  const nrm = new Float32Array(n * 3)
  const uv = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    nrm[i * 3 + 1] = 1
    uv[i * 2] = 0.5
    uv[i * 2 + 1] = 0.5
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4))
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(idx)
  // the key-light throw (height / tan elevation) + the fixed offset along the
  // sun azimuth + the slide toward the roll's LOW edge (local −x for a positive
  // roll: `rotateZ` lifts the +x side)
  const off = radius * LEAF_SHADOW_OFFSET
  const rollX = -Math.sin(roll) * radius * LEAF_SHADOW_ROLL
  return geo.translate(
    h * LEAF_SHADOW_PER_HEIGHT[0] + off * SUN_XZ[0] + rollX,
    0,
    h * LEAF_SHADOW_PER_HEIGHT[1] + off * SUN_XZ[1],
  )
}

/** Fraction of the blade radius that stays dead flat before the tip curl. */
const LEAF_CURL_FLAT = 0.55
/** Curl amplitude at the outermost tip, per unit of `size`.
 *
 * A fallen leaf is not a decal — its lobe tips lift off the ground and catch
 * the key light, and that separation is most of why leaves read as objects
 * instead of stickers. The lift is a pure function of the RADIUS from the blade
 * centre (flat inside LEAF_CURL_FLAT, quadratic ramp outside), so the lid's
 * normal is a function of radius too and the fan "pinwheel" (see
 * `flattenCapNormals`) is unreachable: fan triangles at the same radius get the
 * SAME normal by construction.
 *
 * The amplitude is bounded by that same requirement, not by taste: the steepest
 * cap slope is 2·A/((1 − flat)·LEAF_RADIUS), and the gate in build.test.ts
 * measures the most bent lid normal against the blade's own plane (undoing the
 * rigid lie first, so it cannot be fooled by LEAF_LIE).
 *
 * 4% OF THE BLADE RADIUS: with the per-instance tilt at 1-2° (see LEAF_SCATTER)
 * the curl is the ONLY thing separating two overlapping blades by shading, so
 * it has to be a real curl; and with the blade nearly flat on the surface it
 * must not be so deep that a lobe tip stops looking seated. */
export const LEAF_CURL_FRAC = 0.04
const LEAF_CURL = LEAF_CURL_FRAC * LEAF_RADIUS

/** THE LIE — every blade's crown end is lifted this far off the surface.
 *
 * A dried leaf's stem end stays down and its blade cants up; every archetype
 * seats its LOWEST vertex on the surface, so the contact is real and the crown
 * hovers. That is the second half of "so it never reads as a decal" — the first
 * half being the tip curl above.
 *
 * It is a RIGID rotation of the whole die-cut, so the lid keeps ONE normal and
 * shades as one surface (the reason this is a lie and not a spine curl: a
 * quadratic curl's far-end normal is 40° off the blade and the lid breaks into
 * two values), and the blade's thickness, footprint radius and seating are
 * unchanged apart from the exact cos/sin the gates re-derive. Per-blade deltas
 * (±0.035 rad) keep a clump from reading as one stamped angle.
 *
 * Only 1.5°: leaves should lie "nearly flat on the surface with a slight curl
 * at the tips", and a larger lie reads as a leaf STANDING UP. Grounding comes
 * from the drawn contact shadow (`contactShadowGeom`) plus the tip curl; the
 * lie only adds variety between blades of one clump. */
export const LEAF_LIE = (1.5 * Math.PI) / 180

/** Lift the tips. Rigid vertical shear: top and bottom lid move together, so
 * the die-cut keeps its thickness everywhere. Cap normals are re-derived
 * analytically (the `furl` trick, one axis over); wall normals are horizontal
 * and a vertical shear barely touches them. */
function curlLeafTips(geo: THREE.BufferGeometry, size: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute
  const R = LEAF_RADIUS * size
  const A = LEAF_CURL * size
  const span = 1 - LEAF_CURL_FLAT
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const r = Math.hypot(x, z)
    const t = Math.min(1, (r / R - LEAF_CURL_FLAT) / span)
    if (t <= 0) continue
    pos.setY(i, pos.getY(i) + A * t * t)
    const ny = nrm.getY(i)
    if (Math.abs(ny) < 0.9 || r < 1e-6) continue
    const slope = (2 * A * t) / (span * R) // d(A·t²)/dr
    const inv = 1 / Math.hypot(slope, 1)
    const s = Math.sign(ny)
    nrm.setXYZ(i, ((-slope * x) / r) * s * inv, s * inv, ((-slope * z) / r) * s * inv)
  }
  pos.needsUpdate = true
  nrm.needsUpdate = true
  return geo
}

/** The pinwheel guard.
 *
 * The lid of an extrusion is a triangle FAN over a concave polygon, so the
 * moment anything makes it non-planar and normals are recomputed, each fan
 * triangle picks up its own normal and the flat top face renders as value
 * wedges radiating from the centre to every lobe tip. Every lid vertex is
 * therefore hard-assigned the cap plane's own normal, so no deformation can
 * introduce the wedges.
 * Run it AFTER any rotation (groups survive `applyMatrix4`, and the sign is
 * read off the rotated normal), BEFORE `mergeVertices`. */
function flattenCapNormals(geo: THREE.BufferGeometry, axis: 'x' | 'y' | 'z'): THREE.BufferGeometry {
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute
  for (const g of geo.groups) {
    if (g.materialIndex !== 0) continue
    for (let i = g.start; i < Math.min(nrm.count, g.start + g.count); i++) {
      const along = axis === 'x' ? nrm.getX(i) : axis === 'y' ? nrm.getY(i) : nrm.getZ(i)
      const s = Math.sign(along) || 1
      nrm.setXYZ(i, axis === 'x' ? s : 0, axis === 'y' ? s : 0, axis === 'z' ? s : 0)
    }
  }
  nrm.needsUpdate = true
  return geo
}

// ── THE BLENDER BLADE (glbAssets 'maple-leaf') ─────────────────────────────
//
// USER ASK 2026-10-08: the die-cut leaves "lack realism and definition". The
// blade is now a sugar-maple mesh authored in Blender — five unequal lobes with
// teeth, cupped margins and down-curled tips on an interior lattice, a real
// petiole — carrying a DETAIL map (veins light, margin dark; near-white, so it
// MULTIPLIES each blade's tone) and a NORMAL map of the vein relief. Mipmapped
// textures are what make veins affordable at the 45-75 px a blade is delivered
// at: the round-4 "anti-noise law" banned vein GEOMETRY, whose edges alias into
// stipple, and a filtered map has no edges to alias.
//
// The asset is normalised ONCE into the procedural blade's own frame — centre
// at the origin, crown toward −Z, lowest point on y = 0 — and scaled so its
// rotation-safe radius (petiole included) is exactly LEAF_RADIUS per unit of
// `size`. Every footprint, clearance and scatter rule written against
// LEAF_RADIUS therefore holds unchanged for the new blade.

let unitBladeCache: { version: number; geometry: THREE.BufferGeometry; zMin: number; zMax: number } | null = null

function unitAssetBlade(): { geometry: THREE.BufferGeometry; zMin: number; zMax: number } | null {
  const asset = decorAsset('maple-leaf')
  if (!asset) return null
  const v = decorAssetsVersion()
  if (unitBladeCache && unitBladeCache.version === v) return unitBladeCache
  const g = asset.geometry.clone()
  g.computeBoundingBox()
  const bb = g.boundingBox!
  const cx = (bb.min.x + bb.max.x) / 2
  const cz = (bb.min.z + bb.max.z) / 2
  g.translate(-cx, -bb.min.y, -cz)
  const pos = g.getAttribute('position')
  let r = 0
  for (let i = 0; i < pos.count; i++) r = Math.max(r, Math.hypot(pos.getX(i), pos.getZ(i)))
  const s = LEAF_RADIUS / r
  g.scale(s, s, s)
  g.computeBoundingBox()
  unitBladeCache = { version: v, geometry: g, zMin: g.boundingBox!.min.z, zMax: g.boundingBox!.max.z }
  return unitBladeCache
}

/** THE ASSET BLADE'S TIP LIFT (contact pass 2026-10-09: "leaves look like
 * decals"). The Blender blade carries its own lift (TIP_LIFT 0.048 of a leaf
 * height in canadiana_assets.py), but the die-cut's radius curl
 * (`curlLeafTips`) was never applied to it — and the clump STACK step was
 * budgeted for exactly that curl (LEAF_STACK_FRAC = thickness + ½ LEAF_CURL).
 * So the clump blades get it back at LEAF_CURL_FRAC, inside the budget the
 * stack already pays for; a SINGLE, which nothing lies on, takes
 * LEAF_SINGLE_TIP_LIFT. Same radius-only profile as the die-cut (flat inside
 * LEAF_CURL_FLAT, quadratic ramp outside), so it cannot fan, and the shading
 * normal tilts with the slope so the raised points catch the key light. */
export const LEAF_SINGLE_TIP_LIFT = 0.1

function liftAssetTips(geo: THREE.BufferGeometry, size: number, frac: number): void {
  if (frac <= 0) return
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
  const R = LEAF_RADIUS * size
  const A = frac * LEAF_RADIUS * size
  const span = 1 - LEAF_CURL_FLAT
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const r = Math.hypot(x, z)
    const t = Math.min(1, (r / R - LEAF_CURL_FLAT) / span)
    if (t <= 0) continue
    pos.setY(i, pos.getY(i) + A * t * t)
    if (!nrm || r < 1e-6) continue
    // height field y += f(r): the surface normal n becomes (n − ∇f · n.y),
    // renormalised (exact for a horizontal lid, close for the cupped blade)
    const slope = (2 * A * t) / (span * R)
    const ny = nrm.getY(i)
    const nx = nrm.getX(i) - ((slope * x) / r) * ny
    const nz = nrm.getZ(i) - ((slope * z) / r) * ny
    const inv = 1 / Math.hypot(nx, ny, nz)
    nrm.setXYZ(i, nx * inv, ny * inv, nz * inv)
  }
  pos.needsUpdate = true
  if (nrm) nrm.needsUpdate = true
}

/** One asset blade at `size`, toned like the die-cut: an RGBA ramp from
 * `base` at the petiole end (+Z) to `tip` at the crown (−Z) — the same single
 * monotone break `tintLeafGroups` draws — on top of the detail map. */
function assetLeafGeom(size: number, tone: LeafTone, tipLift = LEAF_CURL_FRAC): THREE.BufferGeometry | null {
  const unit = unitAssetBlade()
  if (!unit) return null
  const g = unit.geometry.clone()
  g.scale(size, size, size)
  liftAssetTips(g, size, tipLift)
  const pos = g.getAttribute('position')
  const colors = new Float32Array(pos.count * 4)
  const tipC = new THREE.Color(tone.tip)
  const baseC = new THREE.Color(tone.base)
  const span = (unit.zMax - unit.zMin) * size
  const z0 = unit.zMax * size
  for (let i = 0; i < pos.count; i++) {
    const u = Math.min(1, Math.max(0, (z0 - pos.getZ(i)) / span))
    colors[i * 4] = baseC.r + (tipC.r - baseC.r) * u
    colors[i * 4 + 1] = baseC.g + (tipC.g - baseC.g) * u
    colors[i * 4 + 2] = baseC.b + (tipC.b - baseC.b) * u
    colors[i * 4 + 3] = 1
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 4))
  return g
}

/** One leaf lying in the XZ plane (thickness on Y): NEARLY flat — the round-3
 * cup is still gone (see `flattenCapNormals`), and what replaces it is the
 * radius-only tip curl, which cannot fan (see `curlLeafTips`).
 *
 * `lie` lifts the crown (LEAF_LIE ± a per-blade delta) and `roll` rocks the
 * blade about its own stem→crown axis for variety. Both are applied AFTER the
 * curl, as rigid rotations of the finished die-cut: the curl is authored in the
 * blade's own flat frame, so the two can never interfere, and the gates recover
 * that frame by undoing the measured plane normal.
 *
 * Extrude output is non-indexed; `mergeVertices` re-indexes it so the leaf can
 * merge with the indexed primitive parts. */
function mapleLeafGeom(size: number, tone: LeafTone, lie = LEAF_LIE, roll = 0, tipLift = LEAF_CURL_FRAC): THREE.BufferGeometry {
  const blade = assetLeafGeom(size, tone, tipLift)
  if (blade) {
    if (roll) blade.rotateZ(roll)
    if (lie) blade.rotateX(lie)
    return blade
  }
  const geo = new THREE.ExtrudeGeometry(mapleLeafShape(size), leafExtrude(size))
  tintLeafGroups(geo, size, tone)
  geo.rotateX(-Math.PI / 2) // lie flat on the desk/board (crown → −Z)
  flattenCapNormals(geo, 'y')
  curlLeafTips(geo, size)
  const out = mergeVertices(geo)
  if (roll) out.rotateZ(roll) // rock about the stem→crown axis
  if (lie) out.rotateX(lie) // …then lift the crown end off the surface
  return out
}

/** The desk plane's paving clearance. The city background paves the desk ring
 * at +0.45 (apron/quay), +0.95 (pads) and +1.4 (street ribbons) above the desk
 * plane (backgrounds.ts) — anything seated at the plane gets sliced into a
 * dithered splat by the street layer. The DESK props are seated so their LOWEST
 * vertex sits exactly here, which keeps every lobe — and the desk flag's base
 * disc and pole foot — clear of all three paving planes; 1.7 is imperceptible
 * hover at maquette scale. */
const CITY_PAVING_CLEAR = 1.7

/** The blade's own seat ABOVE its contact decal. The shadow is drawn (see
 * `contactShadowGeom`), so all this height has to do is keep the die-cut off
 * the decal without letting the leaf hover. 0.9 units is 0.22 mm at the desk
 * pencil's 4.1 units/cm. */
const BLADE_OVER_DECAL = 0.9

/** …and the decal's own clearance above the surface it is drawn on. It must be
 * high enough not to z-fight the board/desk plane and low enough to stay under
 * the sun's 1.5-unit normalBias line, so it can never appear in the shadow map
 * even if a future change re-enables casting on the leaf archetypes. */
const DECAL_CLEAR = 0.3

/** The desk flag, authored once so the leaf sizes can be capped against it and
 * the gate can measure the sheet in the builder's own frame.
 *
 *   • The base disc is steel-grey with a darker contact ring: a tan disc is
 *     within a few % luminance of the workbench (#C8A87A) and disappears.
 *   • The flag seats on CITY_PAVING_CLEAR like the leaves, so the CITY
 *     background's desk paving planes do not cut across the disc and pole foot.
 *   • POLE_R is 1.4: at the ~2 px a hero frame delivers, a thinner pole reads
 *     as a bare wire. */
export const FLAG = {
  BASE_R: 15,
  BASE_H: 2.2,
  RING_R: 9.2,
  RING_H: 1.4,
  POLE_R: 1.4,
  POLE_TOP: 68.2,
  FINIAL_R: 1.7,
  SHEET_W: 52,
  SHEET_H: 26,
  SHEET_Y: 47,
  SHEET_T: 0.6,
} as const

/** Overall height of the `canada-flag` prop (finial included). */
export const FLAG_HEIGHT = FLAG.POLE_TOP + 0.6 + FLAG.FINIAL_R

/** Every leaf's longest dimension, at the TOP of its archetype's scale jitter,
 * must fit inside this.
 *
 * A real sugar-maple blade is 12-16 cm; the desk pencil is 78 units ≈ 19 cm, so
 * the scene runs at 4.1 units/cm and a life-size blade is 49-66 units. 0.95 of
 * the 70.5-unit desk flag is 67 — the top of that range, where the large DESK
 * leaves live (the board's rim-clearance rule caps a board blade at ~52 units,
 * see LEAF_BOARD_R_MAX). It is still a cap: it keeps a desk blade from
 * creeping toward the moose. */
export const LEAF_MAX_SPAN = 0.95 * FLAG_HEIGHT

/** Hard ceiling on the rotation-safe radius (at scale 1) of ANY board-zone leaf
 * archetype, derived — not guessed — from `placeDecor`'s own rules for the
 * 'open' band: a cell centre clears the slab rim by >30, the cell then jitters
 * by up to (footprint − DECOR_CELL)/2 in each axis, and an instance may be
 * scaled up to 1.05 by the registry's jitter. With footprint = R (the registry
 * rounds up), solving 1.05·R ≤ 30 − (R − 20)/2 gives R ≤ 40/1.55 = 25.81.
 *
 * 25.81 of radius is a 51-unit blade, ~52 px at the default framing. Larger
 * blades therefore live on the desk annulus, which has no rim to straddle, no
 * cards to hide under and no cable ribbons to be crossed by. */
export const LEAF_BOARD_R_MAX = 40 / 1.55

/** A clump blade: size FACTOR of the clump's base blade, in-clump yaw offset,
 * LIE DELTA (added to LEAF_LIE), roll about the stem→crown axis, slot centre as
 * a fraction of the BASE blade's radius (x, z), tone name, MUTED flag.
 *
 * Three separation invariants on these rows, all gated:
 *
 *  • CENTRE-TO-CENTRE ≥ LEAF_CLUMP_SEP × the mean diameter of the two blades.
 *    Two die-cuts closer than that fuse into one amorphous blob at delivered
 *    size;
 *  • YAW DELTA ≥ LEAF_CLUMP_YAW_MIN between any two blades in a clump, so an
 *    overlap reads as two leaves lying across each other rather than one
 *    thicker leaf;
 *  • AIR GAP — each blade is stacked LEAF_CLUMP_AIR of its own die-cut
 *    thickness clear of the one below (on top of the full thickness), so an
 *    overlap is a PILE and no part of a lower blade can surface through an
 *    upper one.
 *
 * The LIE DELTAS stay inside ±0.035 rad (±2°) of LEAF_LIE: enough that a clump
 * is several separate angles rather than one stamped one, small enough that no
 * blade loses the lift LEAF_LIE exists to buy.
 *
 * The YAWS are authored NEAR 0 OR NEAR π (within LEAF_CLUMP_YAW_DEV_MAX), and
 * that is a constraint, not a style: a clump's blade azimuth is the
 * INSTANCE yaw plus this offset, and the instance yaw is the only thing the
 * depth-axis fence can reach. Anchoring the offsets on {0, π} — the two values
 * that map the fence's allowed set onto itself — is what lets `mapleClumpFence`
 * widen the instance fence by the largest deviation and guarantee that EVERY
 * blade in the scene, not just every instance, clears the collapse azimuth.
 * 0 and π are 180° apart, so a clump still reads as leaves lying across each
 * other rather than as one stamp (the gate measures the spread).
 *
 * The ROLLS stay inside LEAF_ROLL_CLUMP_MAX — smaller than a single's, because
 * inside a clump a roll lifts one edge of a blade toward the blade stacked on
 * top of it, and `mapleClumpLayout` has to buy that lift back out of the stack
 * step (see LEAF_STACK_FRAC). */
type ClumpRow = readonly [number, number, number, number, number, number, LeafToneName, boolean]

/** Minimum centre-to-centre distance inside a clump, as a fraction of the two
 * blades' MEAN diameter. */
export const LEAF_CLUMP_SEP = 0.55
/** Minimum in-clump yaw delta, radians (25°). */
export const LEAF_CLUMP_YAW_MIN = (25 * Math.PI) / 180
/** Clear air above each stacked blade, as a fraction of its own STACK step —
 * die-cut thickness plus half its tip curl, because with a 0.4-unit blade the
 * curl is now the taller of the two and a pure thickness step would let an
 * upper blade's flat centre sink through a lower blade's raised lobe. */
export const LEAF_CLUMP_AIR = 0.45
/** Vertical step between stacked blades, per unit of `size` — the die-cut
 * thickness plus half the tip curl. `stepOf` adds the roll term. */
const LEAF_STACK_FRAC = LEAF_THICK_FRAC + 0.5 * LEAF_CURL

/** THE ROLL — how far a blade rocks about its own stem→crown axis.
 *
 * The fence above fixes WHICH way a blade points; the roll keeps it from being
 * coplanar with the deck. A roll tips one half of the die-cut toward the camera
 * and the other away, so the lid stops being one flat value and the blade
 * separates from the surface — and unlike a bigger LEAF_LIE it does NOT raise
 * the crown, which turns the leaf into a claw. ±0.03 rad is too small to see.
 *
 * A SINGLE gets the full ±0.20 rad (11.5°): its low edge seats on the surface
 * and its shadow slides to follow it (LEAF_SHADOW_ROLL), so the raised edge
 * reads as lifted rather than as floating. The projected width only loses
 * cos(0.2) = 2%.
 *
 * A CLUMP blade gets ±0.05: inside a clump the raised edge points at the blade
 * stacked above it, and `stepOf` has to buy that lift out of the stack. */
export const LEAF_ROLL_MAX = 0.2
export const LEAF_ROLL_CLUMP_MAX = 0.05

/** The vertical step blade `i` puts between itself and blade `i+1`.
 *
 * The roll term is taken at HALF the blade's half-width, not at the rim: the
 * lift is linear in |x| and the clump rule already keeps centres ≥
 * LEAF_CLUMP_SEP of the mean diameter apart, so an upper blade never passes
 * over the rolled blade's outermost edge — and LEAF_CLUMP_AIR then adds 45% on
 * top of whatever this comes to. */
function stepOf(size: number, roll: number): number {
  const rollLift = Math.abs(Math.sin(roll)) * (LEAF_W / 4) * size
  return (LEAF_STACK_FRAC * size + rollLift) * (1 + LEAF_CLUMP_AIR)
}

/** The clumps — loose drifts of 2-4 leaves, several drifts.
 *
 * BOARD clumps are sized backwards from LEAF_BOARD_R_MAX with the separation
 * rule already applied (which is what makes them smaller than a board single:
 * two blades that must stay 0.55 diameters apart need more room than one).
 * Slots are fractions of the base blade's radius, so a clump keeps its shape at
 * any size, and every clump still overlaps itself — fallen leaves lie ON one
 * another, they just no longer fuse.
 *
 * VIEW3D QUALITY LOOP 3 — EACH BLADE KEEPS ITS WHOLE FLAG SILHOUETTE. The
 * 0.55-diameter rule still let a blade lose 19-25% of its plan area under its
 * neighbours (drift 25.2%, cluster 24.9%, pair 18.7% — measured on the shipped
 * Blender blade by glbAssets.test.ts), and workbench-leaf.png showed no single
 * complete 11-point outline in the desk pile. The slots were pushed out along
 * their own directions (pair ×1.2, pairB ×1.12, drift/bank/cluster ×1.25) so
 * no blade loses more than 15% (the gate); the clumps grew ~2 units of radius
 * (board) and ~4 (desk cluster), which the registry footprints track.
 *
 * TONES follow the archetype's SURFACE (round 4 #3): the three board clumps
 * draw from LEAF_TONE_MIX_BOARD (crimson / burnt orange / pale amber / dark
 * brown), the desk cluster from LEAF_TONE_MIX_DESK (crimson and dark brown
 * only). The trailing boolean is the MUTED flag. */
const LEAF_CLUMPS: Record<LeafClumpKind, { base: number; surface: LeafSurface; rows: readonly ClumpRow[] }> = {
  // BOARD pair A — the smallest drift, and the one that slots into cells the
  // 3-blade drift cannot reach.
  pair: {
    base: 27,
    surface: 'board',
    rows: [
      [1.0, 0.3, 0.03, -0.045, -0.456, 0.168, 'scarlet', false],
      [0.8, Math.PI - 0.28, -0.028, 0.038, 0.66, -0.3, 'amber', false],
    ],
  },
  // BOARD pair B — avoids a cloned motif. One geometry can only carry
  // one arrangement, so three placements of ONE pair archetype are three
  // identical couples at the same relative offset, scale and yaw. B is an
  // independent couple: different partner scale, separation, yaws and tones.
  pairB: {
    base: 26,
    surface: 'board',
    rows: [
      [1.0, -0.26, -0.031, 0.05, -0.336, -0.224, 'vermillion', false],
      [0.6, Math.PI + 0.22, 0.026, -0.041, 0.874, 0.448, 'ochre', true],
    ],
  },
  // BOARD drift — the three.
  drift: {
    base: 25,
    surface: 'board',
    rows: [
      [1.0, Math.PI - 0.2, 0.022, -0.048, -0.575, -0.425, 'scarlet', false],
      [0.88, Math.PI + 0.3, -0.032, 0.044, 0.725, -0.4, 'vermillion', true],
      [0.78, -0.31, 0.015, 0.036, -0.0625, 0.9, 'amber', false],
    ],
  },
  // BOARD bank — the one clump that does not live on open paper: its registry
  // entry rides the 'near-connection' affinity, so it collects in the 10-34 px
  // shoulder of a cable run (leaves accumulating against an obstacle, which the
  // scatter alone cannot produce). Sized against LEAF_BOARD_R_MAX like the rest.
  bank: {
    base: 25,
    surface: 'board',
    rows: [
      [1.0, -0.2, 0.026, 0.047, -0.625, -0.375, 'scarlet', false],
      [0.85, Math.PI + 0.19, -0.03, -0.043, 0.75, -0.45, 'scarlet', true],
      [0.72, 0.28, 0.018, 0.039, -0.125, 0.925, 'vermillion', false],
    ],
  },
  // DESK cluster — the four, on beige: all FOUR breaks, with the amber
  // darkened for this surface (LEAF_SURFACE_L).
  cluster: {
    base: 28,
    surface: 'desk',
    rows: [
      [1.0, Math.PI + 0.22, 0.02, -0.046, -0.65, -0.375, 'scarlet', false],
      [0.88, Math.PI - 0.24, -0.03, 0.05, 0.7, -0.525, 'vermillion', false],
      [0.78, -0.32, 0.032, 0.042, -0.25, 0.975, 'amber', false],
      [0.68, 0.3, -0.022, -0.037, 0.9, 0.575, 'ochre', true],
    ],
  },
}

/** The LONE blades. Singles are the most numerous leaf in the scene and one
 * geometry can only carry one tone, so each is its own archetype.
 *
 * The BIGGEST single is a BOARD blade. The desk has NO rim rule, and
 * `placeDecor` lets a desk cell sit 10 units outside the slab, so a large desk
 * blade could reach back over the board and be sliced by its rim; the board cap
 * (LEAF_BOARD_R_MAX) is PROVABLE clearance. So `mini` is the hero (35 × LEAF_W
 * = 44 units, radius 25.4 against the 25.81 ceiling) and the desk blades are
 * smaller — which also matches the frame: the board is what the camera
 * centres on. */
const LEAF_SINGLES: Record<
  'fall' | 'fallB' | 'mini' | 'miniB' | 'miniC',
  { size: number; surface: LeafSurface; tone: LeafToneName; muted: boolean; dLie: number; roll: number }
> = {
  mini: { size: 35, surface: 'board', tone: 'scarlet', muted: false, dLie: 0.025, roll: -0.19 },
  miniB: { size: 30, surface: 'board', tone: 'vermillion', muted: false, dLie: -0.02, roll: 0.2 },
  miniC: { size: 26, surface: 'board', tone: 'amber', muted: false, dLie: 0.018, roll: -0.16 },
  fall: { size: 34, surface: 'desk', tone: 'scarlet', muted: false, dLie: 0.02, roll: 0.18 },
  fallB: { size: 28, surface: 'desk', tone: 'vermillion', muted: true, dLie: -0.024, roll: -0.2 },
}

/** One declared blade. */
export interface LeafBlade {
  tone: LeafToneName
  muted: boolean
}

/** Every archetype id in the leaf family → the surface it lands on. */
export const LEAF_SURFACE: Record<string, LeafSurface> = {
  'maple-leaf-cluster': LEAF_CLUMPS.cluster.surface,
  'maple-leaf-drift': LEAF_CLUMPS.drift.surface,
  'maple-leaf-pair': LEAF_CLUMPS.pair.surface,
  'maple-leaf-pair-b': LEAF_CLUMPS.pairB.surface,
  'maple-leaf-bank': LEAF_CLUMPS.bank.surface,
  'maple-leaf-fall': LEAF_SINGLES.fall.surface,
  'maple-leaf-fall-b': LEAF_SINGLES.fallB.surface,
  'maple-leaf-mini': LEAF_SINGLES.mini.surface,
  'maple-leaf-mini-b': LEAF_SINGLES.miniB.surface,
  'maple-leaf-mini-c': LEAF_SINGLES.miniC.surface,
}

/** Every archetype id in the leaf family → the blades it carries, in stacking
 * order. The gates read THIS (not a copy) for the per-surface mix, the
 * dark-share cap, the muted share and the per-archetype blade counts. */
export const LEAF_BLADES: Record<string, readonly LeafBlade[]> = {
  'maple-leaf-cluster': LEAF_CLUMPS.cluster.rows.map((r) => ({ tone: r[6], muted: r[7] })),
  'maple-leaf-drift': LEAF_CLUMPS.drift.rows.map((r) => ({ tone: r[6], muted: r[7] })),
  'maple-leaf-pair': LEAF_CLUMPS.pair.rows.map((r) => ({ tone: r[6], muted: r[7] })),
  'maple-leaf-pair-b': LEAF_CLUMPS.pairB.rows.map((r) => ({ tone: r[6], muted: r[7] })),
  'maple-leaf-bank': LEAF_CLUMPS.bank.rows.map((r) => ({ tone: r[6], muted: r[7] })),
  'maple-leaf-fall': [{ tone: LEAF_SINGLES.fall.tone, muted: LEAF_SINGLES.fall.muted }],
  'maple-leaf-fall-b': [{ tone: LEAF_SINGLES.fallB.tone, muted: LEAF_SINGLES.fallB.muted }],
  'maple-leaf-mini': [{ tone: LEAF_SINGLES.mini.tone, muted: LEAF_SINGLES.mini.muted }],
  'maple-leaf-mini-b': [{ tone: LEAF_SINGLES.miniB.tone, muted: LEAF_SINGLES.miniB.muted }],
  'maple-leaf-mini-c': [{ tone: LEAF_SINGLES.miniC.tone, muted: LEAF_SINGLES.miniC.muted }],
}

/** Every in-clump yaw offset (exported for the scatter gate). */
export const LEAF_CLUMP_YAWS: readonly number[] = [
  ...new Set(Object.values(LEAF_CLUMPS).flatMap((c) => c.rows.map((r) => r[1]))),
]

/** Half-extents of a yawed blade in the ground plane, straight off the outline:
 * the extrusion runs along Y, so the blade's XZ footprint IS the polygon.
 * Analytic, so the clump layout below stays a pure function. */
function bladeHalfExtents(size: number, yaw: number): { hx: number; hz: number } {
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (const [px, py] of MAPLE_LEAF_OUTLINE) {
    // mapleLeafShape maps outline (x, y) → world (x·size, −(y − mid)·size)
    const x = px * size
    const z = -(py - LEAF_MID_Y) * size
    const rx = x * cos + z * sin
    const rz = -x * sin + z * cos
    x0 = Math.min(x0, rx)
    x1 = Math.max(x1, rx)
    z0 = Math.min(z0, rz)
    z1 = Math.max(z1, rz)
  }
  return { hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 }
}

export interface ClumpBlade {
  size: number
  tone: LeafTone
  toneName: LeafToneName
  muted: boolean
  yaw: number
  /** crown lift — LEAF_LIE plus this blade's own delta */
  lie: number
  /** roll about the blade's stem→crown axis */
  roll: number
  /** slot centre in the clump's own XZ frame */
  cx: number
  cz: number
  hx: number
  hz: number
  /** the blade's own rotation-safe radius (PLAN — the lie only shrinks the XZ
   * footprint, so using the plan radius keeps every footprint conservative) */
  r: number
  /** height this blade is stacked at inside the clump, before the clump itself
   * is seated. Strictly increasing by a full die-cut thickness PLUS
   * LEAF_CLUMP_AIR of clear air, which is what makes an overlap a PILE. */
  seat: number
}

export type LeafClumpKind = 'pair' | 'pairB' | 'drift' | 'cluster' | 'bank'

/** How far a clump's rows deviate from the fence-safe anchors {0, π}. */
export function mapleClumpYawDev(kind: LeafClumpKind): number {
  return Math.max(
    ...LEAF_CLUMPS[kind].rows.map(([, yaw]) => {
      const t = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      return Math.min(t, Math.abs(t - Math.PI), Math.PI * 2 - t)
    }),
  )
}

/** …and the instance fence that keeps EVERY blade of the clump — not just its
 * lead — clear of the camera's depth axis by LEAF_YAW_FORBID. */
export function mapleClumpFence(kind: LeafClumpKind): number {
  return LEAF_YAW_FORBID + mapleClumpYawDev(kind)
}

/**
 * A clump's layout. PURE — the gate reads exactly what the builder builds, and
 * `radius` is the number the registry footprint has to match (it is both the
 * collision half-extent and, for the board clumps, what LEAF_BOARD_R_MAX
 * bounds).
 */
export function mapleClumpLayout(kind: LeafClumpKind): { blades: ClumpBlade[]; radius: number } {
  const { base, rows, surface } = LEAF_CLUMPS[kind]
  const R0 = LEAF_RADIUS * base
  let seat = 0
  const blades: ClumpBlade[] = rows.map(([f, yaw, dLie, roll, ux, uz, toneName, muted], i) => {
    const size = base * f
    const { hx, hz } = bladeHalfExtents(size, yaw)
    const blade: ClumpBlade = {
      size,
      tone: leafTone(toneName, `${kind}:${i}`, muted, surface),
      toneName,
      muted,
      yaw,
      lie: LEAF_LIE + dLie,
      roll,
      cx: ux * R0,
      cz: uz * R0,
      hx,
      hz,
      r: LEAF_RADIUS * size,
      seat,
    }
    seat += stepOf(size, roll)
    return blade
  })
  return { blades, radius: Math.max(...blades.map((b) => Math.hypot(b.cx, b.cz) + b.r)) }
}

/** A blade's mean height above the surface — what the contact decal offsets by
 * along the key-light vector. */
function bladeShadowHeight(size: number, seat: number): number {
  return BLADE_OVER_DECAL + seat + leafThickness(size) / 2 + (LEAF_CURL * size) / 3
}

/** A clump's blades, each posed in the clump's own frame exactly as the
 * clump mesh carries them (before the clump is seated). Exported so the
 * overlap gate measures the shipped blades — the Blender asset when it is
 * registered — rather than a copy of this transform. */
export function mapleClumpBladeGeoms(kind: LeafClumpKind): THREE.BufferGeometry[] {
  return mapleClumpLayout(kind).blades.map((b) => {
    const geo = mapleLeafGeom(b.size, b.tone, b.lie, b.roll)
    geo.rotateY(b.yaw)
    geo.computeBoundingBox()
    const bb = geo.boundingBox!
    return geo.translate(
      b.cx - (bb.min.x + bb.max.x) / 2,
      BLADE_OVER_DECAL + b.seat - bb.min.y,
      b.cz - (bb.min.z + bb.max.z) / 2,
    )
  })
}

/** Build a clump: PER-BLADE contact decals first (so they paint before the
 * blades in the merged index buffer — see the `contactShadowGeom` block on why
 * `depthWrite` is off), then the blades themselves, then the whole thing seated
 * so its LOWEST vertex sits exactly `DECAL_CLEAR` above `surfaceY`. */
function mapleClumpGeom(kind: LeafClumpKind, surfaceY: number): THREE.BufferGeometry {
  const { blades } = mapleClumpLayout(kind)
  const decals = blades.map((b) =>
    contactShadowGeom(b.r, bladeShadowHeight(b.size, b.seat), b.roll).translate(b.cx, 0, b.cz),
  )
  const merged = mergeParts([...decals, ...mapleClumpBladeGeoms(kind)])
  merged.computeBoundingBox()
  return merged.translate(0, surfaceY + DECAL_CLEAR - merged.boundingBox!.min.y, 0)
}

/** A lone blade plus its contact decal, seated so the decal sits exactly
 * `DECAL_CLEAR` above `surfaceY`. */
function mapleLeafSingleGeom(kind: keyof typeof LEAF_SINGLES, surfaceY: number): THREE.BufferGeometry {
  const s = LEAF_SINGLES[kind]
  const tone = leafTone(s.tone, `single:${kind}`, s.muted, s.surface)
  const geo = mapleLeafGeom(s.size, tone, LEAF_LIE + s.dLie, s.roll, LEAF_SINGLE_TIP_LIFT)
  geo.computeBoundingBox()
  geo.translate(0, BLADE_OVER_DECAL - geo.boundingBox!.min.y, 0)
  const decal = contactShadowGeom(LEAF_RADIUS * s.size, bladeShadowHeight(s.size, 0), s.roll)
  const merged = mergeParts([decal, geo])
  merged.computeBoundingBox()
  return merged.translate(0, surfaceY + DECAL_CLEAR - merged.boundingBox!.min.y, 0)
}

/** The rotation-safe radius of a lone blade at scale 1 — what the registry
 * footprint is rounded up from. */
export function mapleSingleRadius(kind: keyof typeof LEAF_SINGLES): number {
  return LEAF_RADIUS * LEAF_SINGLES[kind].size
}

/** …and its longest dimension, for the LEAF_MAX_SPAN gate. */
export function mapleSingleSpan(kind: keyof typeof LEAF_SINGLES): number {
  return Math.max(LEAF_W, LEAF_H) * LEAF_SINGLES[kind].size
}

// ── the desk flag ──────────────────────────────────────────────────────────
// The cloth must not read as a sheared parallelogram leaning off a vertical
// pole. Three things in the geometry ensure that:
//
//  (a) the hoist edge is SNAPPED to the pole surface (x = POLE_R) and both
//      hoist corners are clipped to the pole, so no gap can open up with
//      distance;
//  (b) the cloth FURLS instead of leaning: z is displaced by a sine whose
//      amplitude is zero at the hoist and ramps to 6% of the flag width at the
//      fly edge, and the front/back normals are re-derived from that slope so
//      the sheet shades as cloth rather than as card. A curved sheet cannot be
//      mistaken for a sheared one;
//  (c) the sheet is a flat upright plane, which is edge-on unreadable for half
//      the circle, so it gets the same yaw discipline the leaves get
//      (FLAG_YAW_BAND) — its normal is folded onto the camera azimuth ±0.5 rad
//      and the emblem is always broadside.
//
// The emblem is its own stencil (FLAG_EMBLEM_OUTLINE, see above): at the
// ~13-20 px the glyph is delivered at, the blade outline would be a smear. The
// sheet is 52 × 26 on a 70.5-unit mast so the glyph gets enough pixels to be
// recognised; its size is set by FLAG_EMBLEM_FRAC.
//
// Band geometry is the real flag's: split 11/22/11 — the white square is
// exactly 2× a red band, i.e. cuts at 0.25 / 0.75. It is ONE box with 12 width
// segments (so both cuts land exactly on a vertex column), tinted per TRIANGLE
// by centroid: three butted panels each showed the inward-facing side wall of a
// red band painted over the white panel's edge, and one box has no interior
// walls to show.

/** Emblem HEIGHT as a fraction of the white field's height.
 *
 * Sized by HEIGHT, which is what "fills the square" means (sizing by width puts
 * the crown on the top hem). The outline carries a stem, so the bbox centre it
 * is centred on is the whole glyph's centre. 0.62 × 26 = 16.1 units tall,
 * 15.4 wide, leaving 5.3 units of white margin each side and 4.9 top/bottom. */
export const FLAG_EMBLEM_FRAC = 0.62

const FURL_A = 0.06 * FLAG.SHEET_W
const FURL_K = Math.PI * 1.6

/** Cloth displacement at sheet-local x (world x of the built prop). Exported
 * so the gate can undo the furl and measure the sheet's flat frame. */
export function furlZ(x: number): number {
  const t = Math.min(1, Math.max(0, (x - FLAG.POLE_R) / FLAG.SHEET_W))
  return FURL_A * t * Math.sin(FURL_K * t)
}
/** …and its slope, for the cloth normals. */
function furlSlope(x: number): number {
  const t = Math.min(1, Math.max(0, (x - FLAG.POLE_R) / FLAG.SHEET_W))
  return (FURL_A / FLAG.SHEET_W) * (Math.sin(FURL_K * t) + FURL_K * t * Math.cos(FURL_K * t))
}

/** Apply the furl to a geometry already positioned in the prop's frame.
 * `reNormal` re-derives the ±Z faces' normals from the local slope. */
function furl(geo: THREE.BufferGeometry, reNormal: boolean): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    if (reNormal && nrm && Math.abs(nrm.getZ(i)) > 0.9) {
      const s = furlSlope(x)
      const inv = 1 / Math.hypot(s, 1)
      const sign = Math.sign(nrm.getZ(i))
      nrm.setXYZ(i, -s * sign * inv, 0, sign * inv)
    }
    pos.setZ(i, pos.getZ(i) + furlZ(x))
  }
  pos.needsUpdate = true
  if (nrm) nrm.needsUpdate = true
  return geo
}

function canadaFlagGeom(): THREE.BufferGeometry {
  const STEEL = '#C3BDB2'
  // The foot's tones are picked AGAINST the #C8A87A workbench (a tan disc is
  // invisible on it): a cool slate plate with a darker contact ring.
  const PLATE = '#8E9298'
  const PLATE_DARK = '#6E7278'
  const parts: THREE.BufferGeometry[] = []
  // the weighted base: a WIDE flat plate (about as wide as the banner is
  // tall), with a darker rim ring that
  // gives the contact edge a value break of its own.
  const ring = tint(new THREE.CylinderGeometry(FLAG.BASE_R, FLAG.BASE_R, FLAG.RING_H, 24), PLATE_DARK)
  ring.translate(0, FLAG.RING_H / 2, 0)
  parts.push(ring)
  const base = tint(new THREE.CylinderGeometry(FLAG.BASE_R - 1.6, FLAG.BASE_R - 0.4, FLAG.BASE_H, 24), PLATE)
  base.translate(0, FLAG.RING_H + FLAG.BASE_H / 2, 0)
  parts.push(base)
  const collar = tint(new THREE.CylinderGeometry(FLAG.RING_R * 0.55, FLAG.RING_R, 1.6, 16), PLATE)
  collar.translate(0, FLAG.RING_H + FLAG.BASE_H + 0.8, 0)
  parts.push(collar)
  const footH = FLAG.RING_H + FLAG.BASE_H + 1.6
  const poleH = FLAG.POLE_TOP - footH
  const pole = tint(new THREE.CylinderGeometry(FLAG.POLE_R, FLAG.POLE_R, poleH, 10), STEEL)
  pole.translate(0, footH + poleH / 2, 0)
  parts.push(pole)
  const finial = tint(new THREE.SphereGeometry(FLAG.FINIAL_R, 8, 6), STEEL)
  finial.translate(0, FLAG.POLE_TOP + 0.6, 0)
  parts.push(finial)

  const sheet = new THREE.BoxGeometry(FLAG.SHEET_W, FLAG.SHEET_H, FLAG.SHEET_T, 12, 1, 1).toNonIndexed()
  const sPos = sheet.getAttribute('position')
  const sCol = new Float32Array(sPos.count * 3)
  const RED = new THREE.Color(FLAG_RED)
  const WHITE = new THREE.Color('#FFFFFF')
  for (let t = 0; t < sPos.count; t += 3) {
    const cx = (sPos.getX(t) + sPos.getX(t + 1) + sPos.getX(t + 2)) / 3
    const c = Math.abs(cx) >= FLAG.SHEET_W / 4 ? RED : WHITE
    for (let k = 0; k < 3; k++) {
      sCol[(t + k) * 3] = c.r
      sCol[(t + k) * 3 + 1] = c.g
      sCol[(t + k) * 3 + 2] = c.b
    }
  }
  sheet.setAttribute('color', new THREE.BufferAttribute(sCol, 3))
  const sheetIdx = mergeVertices(sheet)
  // hoist edge PINNED to the pole surface
  sheetIdx.translate(FLAG.POLE_R + FLAG.SHEET_W / 2, FLAG.SHEET_Y, 0)
  furl(sheetIdx, true)
  parts.push(sheetIdx)
  for (const dy of [-FLAG.SHEET_H / 2 + 1.4, FLAG.SHEET_H / 2 - 1.4]) {
    const clip = tint(new THREE.BoxGeometry(2.4, 1.7, 1.5), STEEL)
    clip.translate(FLAG.POLE_R, FLAG.SHEET_Y + dy, 0)
    parts.push(clip)
  }
  // the emblem: FLAG_EMBLEM_FRAC of the white field's HEIGHT, centred on the
  // square in both axes (the shape is centre-origin, so no y correction),
  // extruded thicker than the sheet so it stands proud on BOTH faces
  const LEAF_S = (FLAG_EMBLEM_FRAC * FLAG.SHEET_H) / EMBLEM_H
  const leaf = new THREE.ExtrudeGeometry(flagEmblemShape(LEAF_S), {
    depth: FLAG.SHEET_T + 0.9,
    bevelEnabled: false,
    curveSegments: 1,
  })
  flattenCapNormals(leaf, 'z')
  const leafIdx = tint(mergeVertices(leaf), FLAG_RED)
  leafIdx.translate(FLAG.POLE_R + FLAG.SHEET_W / 2, FLAG.SHEET_Y, -(FLAG.SHEET_T + 0.9) / 2)
  furl(leafIdx, false)
  parts.push(leafIdx)
  return mergeParts(parts)
}

/** FALLBACK only — the shipped moose is the Blender sculpt (moose.glb, see the
 * 'moose' silhouette). Kept so a failed fetch degrades to a moose-shaped toy
 * instead of an empty desk. */
function mooseGeom(): THREE.BufferGeometry {
  const B = '#6B4A33' // dark chocolate
  // deep tan — a paler antler melts into the desk wood at wide framing
  const ANTLER = '#A07E4E'
  const parts: THREE.BufferGeometry[] = []
  const body = tint(new THREE.CapsuleGeometry(14, 34, 4, 12), B)
  body.rotateZ(Math.PI / 2) // lying along X
  body.translate(-5, 36, 0)
  parts.push(body)
  // shoulder hump — the moose signature silhouette
  const hump = tint(new THREE.SphereGeometry(10, 10, 8), B)
  hump.scale(1.2, 0.8, 0.9)
  hump.translate(8, 47, 0)
  parts.push(hump)
  for (const [lx, lz] of [[-17, -6], [-17, 6], [13, -6], [13, 6]] as const) {
    const leg = tint(new THREE.CylinderGeometry(2.6, 3.2, 25, 8), B)
    leg.translate(lx, 12.5, lz)
    parts.push(leg)
  }
  const neck = tint(new THREE.BoxGeometry(10, 15, 8), B)
  neck.rotateZ(-0.5)
  neck.translate(21, 48, 0)
  parts.push(neck)
  // head oversized ~10% so it does not vanish under the antlers
  const head = tint(new THREE.BoxGeometry(14.3, 8.8, 7.7), B)
  head.rotateZ(-0.35)
  head.translate(30, 49, 0)
  parts.push(head)
  const muzzle = tint(new THREE.BoxGeometry(8.6, 7, 6.4), '#5C3F2C')
  muzzle.rotateZ(-0.45)
  muzzle.translate(37.3, 45.8, 0)
  parts.push(muzzle)
  // antlers: broad near-flat palm plates splayed CLEARLY
  // beyond the head silhouette on both sides — the lateral span is the moose
  // read at wide framing — with 3 brow tines rising off each palm and a stem
  // that keeps the plate attached to the skull (no floating props).
  for (const side of [-1, 1] as const) {
    const stem = tint(new THREE.CylinderGeometry(1.0, 1.3, 6, 6), ANTLER)
    stem.rotateX(side * 1.05) // hard outward lean (±Z) from skull to palm
    stem.translate(27.5, 54.5, side * 4.6)
    parts.push(stem)
    // head half-width is 3.85 — the plate spans z ≈ 4.9→15.1 on its side,
    // so the full antler spread (~30) is ~4× the head width
    const palm = tint(new THREE.BoxGeometry(16, 1.8, 11), ANTLER)
    palm.rotateX(side * -0.52) // strong upward cup — shows the plate FACE
    palm.rotateZ(0.18) // slight forward rake
    palm.translate(27, 57.5, side * 10)
    parts.push(palm)
    // rear lobe, yawed off the main plate — breaks the clean-rectangle
    // (floating card) read a single box has from behind
    const lobe = tint(new THREE.BoxGeometry(9, 1.8, 7), ANTLER)
    lobe.rotateY(side * 0.55)
    lobe.rotateX(side * -0.52)
    lobe.translate(20.5, 57.9, side * 11.5)
    parts.push(lobe)
    // brow tines off the plate: dxAlongPalm, outward dz, height, rake
    const tines: [number, number, number, number][] = [
      [6.5, -1.5, 5.5, -0.55],
      [2.5, 2.2, 7, -0.35],
      [-2, 4.2, 6, -0.2],
    ]
    for (const [dx, dzOut, h, rake] of tines) {
      const tine = tint(new THREE.BoxGeometry(1.5, h, 1.5), ANTLER)
      tine.translate(0, h / 2 - 0.6, 0) // base sunk into the palm plate
      tine.rotateZ(rake) // rake forward (+X, where the moose faces)
      tine.rotateX(side * -0.42) // follow the palm's outward cup
      tine.translate(27 + dx, 57.2 + 0.5 * dzOut, side * (10 + dzOut))
      parts.push(tine)
    }
  }
  return mergeParts(parts)
}

/** FALLBACK only — the shipped beaver is the Blender sculpt (beaver.glb, see
 * the 'beaver' silhouette). Kept so a failed fetch degrades to a critter
 * instead of an empty desk. */
function beaverGeom(): THREE.BufferGeometry {
  const B = '#8B5E3C' // warm brown
  const DARK = '#6B4530'
  const parts: THREE.BufferGeometry[] = []
  const body = tint(new THREE.SphereGeometry(11, 14, 10), B)
  body.scale(1.15, 0.82, 0.95)
  body.translate(0, 8.6, 0)
  parts.push(body)
  const head = tint(new THREE.SphereGeometry(6, 12, 9), B)
  head.scale(1.05, 0.9, 0.9)
  head.translate(11.5, 12, 0)
  parts.push(head)
  for (const side of [-1, 1] as const) {
    const ear = tint(new THREE.SphereGeometry(1.4, 8, 6), DARK)
    ear.translate(12.5, 16.4, side * 3)
    parts.push(ear)
  }
  const nose = tint(new THREE.SphereGeometry(1.6, 8, 6), '#4A342A')
  nose.translate(17.2, 12, 0)
  parts.push(nose)
  // the flat oval tail
  const tail = tint(new THREE.SphereGeometry(8, 12, 8), DARK)
  tail.scale(1.5, 0.16, 0.8)
  tail.translate(-19, 1.6, 0)
  parts.push(tail)
  return mergeParts(parts)
}

function loonGeom(): THREE.BufferGeometry {
  // Large enough not to vanish as a dark speck at capture scale, charcoal-
  // bodied with a WHITE CHEST PATCH + collar band (the two-tone waterfowl
  // read), and no ring/torus part of any kind.
  const CHARCOAL = '#2A2A2E'
  const WHITE = '#EDE8DC'
  const parts: THREE.BufferGeometry[] = []
  // horizontal ellipsoid body — waterfowl posture, resting ON the desk
  // (bottom of the hull sits at y=0; groundOffset handles the final lift)
  const body = tint(new THREE.SphereGeometry(11, 16, 12), CHARCOAL)
  body.scale(1.55, 0.72, 0.95) // long (34) and low (16) — never a ring read
  body.translate(-3, 7.9, 0)
  parts.push(body)
  // white chest patch poking out of the charcoal hull at the neck base —
  // the loon's white front, visible from every yaw that shows the chest
  const chest = tint(new THREE.SphereGeometry(6.8, 12, 10), WHITE)
  chest.scale(0.95, 0.88, 0.82)
  chest.translate(9, 6.6, 0)
  parts.push(chest)
  const tail = tint(new THREE.ConeGeometry(4.5, 11, 8), CHARCOAL)
  tail.rotateZ(Math.PI / 2 + 0.16) // tip aft (−X), slightly cocked up
  tail.translate(-20, 9.6, 0)
  parts.push(tail)
  // raised S-curve neck, two leaned segments — the forward-then-recurved
  // rise with the head carried high is the waterfowl profile cue
  const neckLow = tint(new THREE.CylinderGeometry(3.0, 3.7, 8, 10), CHARCOAL)
  neckLow.rotateZ(-0.35) // top leans forward (+X) out of the chest
  neckLow.translate(9.6, 13, 0)
  parts.push(neckLow)
  const neckUp = tint(new THREE.CylinderGeometry(2.6, 3.1, 8, 10), CHARCOAL)
  neckUp.rotateZ(0.16) // slight recurve — head held high over the chest
  neckUp.translate(12.5, 18.4, 0)
  parts.push(neckUp)
  // the white collar band — the loon signature (rides the raised neck)
  const collar = tint(new THREE.CylinderGeometry(3.35, 3.35, 3, 10), WHITE)
  collar.rotateZ(0.16)
  collar.translate(12.75, 17, 0)
  parts.push(collar)
  const head = tint(new THREE.SphereGeometry(4.1, 12, 9), CHARCOAL)
  head.scale(1.18, 0.95, 0.9)
  head.translate(13, 23, 0)
  parts.push(head)
  const beak = tint(new THREE.ConeGeometry(1.25, 7, 8), '#3F4348')
  beak.rotateZ(-Math.PI / 2) // dagger bill held level, tip forward (+X)
  beak.translate(19.8, 22.6, 0)
  parts.push(beak)
  return mergeParts(parts)
}

function rangerHatGeom(): THREE.BufferGeometry {
  const KHAKI = '#B49A6B'
  const parts: THREE.BufferGeometry[] = []
  const brim = tint(new THREE.CylinderGeometry(20, 20, 1.3, 20), KHAKI)
  brim.translate(0, 0.65, 0)
  parts.push(brim)
  const dome = tint(new THREE.SphereGeometry(11.5, 16, 9, 0, Math.PI * 2, 0, Math.PI / 2), KHAKI)
  dome.scale(1, 0.95, 1)
  dome.translate(0, 1.3, 0)
  parts.push(dome)
  const band = tint(new THREE.CylinderGeometry(11.9, 11.9, 2.6, 16), '#8F7A50')
  band.translate(0, 2.6, 0)
  parts.push(band)
  return mergeParts(parts)
}

/** FALLBACK for cn-tower.glb (scripts/blender/desk_tools_assets.py): the
 * souvenir's silhouette on the asset's gabarit — a granite plinth (r 13.6,
 * 3.4 tall), a tapering shaft, the main pod with its dark glass band at
 * ~0.6 H, the SkyPod at 0.8 H and the mast, 123.4 tall in all. Quality pass
 * "cntower": the old 281-unit cone was "the tallest object on the set". */
export const CN_TOWER_HEIGHT = 123.4
function cnTowerGeom(): THREE.BufferGeometry {
  const CONCRETE = '#D3CCBF'
  const WHITE = '#EEECE6'
  const GLASS = '#3A4654'
  const parts: THREE.BufferGeometry[] = []
  const plinth = tint(new THREE.CylinderGeometry(11.2, 13.6, 3.4, 20), '#2E2D30')
  plinth.translate(0, 1.7, 0)
  parts.push(plinth)
  // three-sided (the Y base's footprint) tapering to the pod
  const shaft = tint(new THREE.CylinderGeometry(2, 10.5, 70, 3), CONCRETE)
  shaft.translate(0, 3.4 + 35, 0)
  parts.push(shaft)
  const skirt = tint(new THREE.CylinderGeometry(7.3, 1.9, 3.6, 16), WHITE)
  skirt.translate(0, 75.2, 0)
  parts.push(skirt)
  const glass = tint(new THREE.CylinderGeometry(7.4, 7.3, 3.9, 16), GLASS)
  glass.translate(0, 79, 0)
  parts.push(glass)
  const roof = tint(new THREE.CylinderGeometry(1.75, 7.4, 1.5, 16), WHITE)
  roof.translate(0, 81.7, 0)
  parts.push(roof)
  const upper = tint(new THREE.CylinderGeometry(1.5, 1.75, 13.5, 8), CONCRETE)
  upper.translate(0, 89.2, 0)
  parts.push(upper)
  const sky = tint(new THREE.CylinderGeometry(2.4, 2.8, 3.6, 12), WHITE)
  sky.translate(0, 97.8, 0)
  parts.push(sky)
  const mast = tint(new THREE.CylinderGeometry(0.12, 1.05, CN_TOWER_HEIGHT - 99.6, 8), '#C9C6BF')
  mast.translate(0, 99.6 + (CN_TOWER_HEIGHT - 99.6) / 2, 0)
  parts.push(mast)
  return mergeParts(parts)
}

function compassGeom(): THREE.BufferGeometry {
  const BRASS = '#B08D57'
  const parts: THREE.BufferGeometry[] = []
  const ring = tint(new THREE.TorusGeometry(9.5, 2, 10, 24), BRASS)
  ring.rotateX(Math.PI / 2)
  ring.translate(0, 2, 0)
  parts.push(ring)
  const face = tint(new THREE.CylinderGeometry(9.3, 9.3, 1.6, 20), '#EFE6D3')
  face.translate(0, 1.6, 0)
  parts.push(face)
  const north = tint(new THREE.BoxGeometry(1.9, 0.7, 7), '#C43B2F')
  north.translate(0, 2.7, -3.6)
  parts.push(north)
  const south = tint(new THREE.BoxGeometry(1.9, 0.7, 7), '#3A4A6B')
  south.translate(0, 2.7, 3.6)
  parts.push(south)
  const hub = tint(new THREE.CylinderGeometry(1, 1, 1.1, 8), BRASS)
  hub.translate(0, 2.9, 0)
  parts.push(hub)
  // winding crown at the rim (the pocket-compass read)
  const crown = tint(new THREE.CylinderGeometry(1.6, 1.6, 2.6, 8), BRASS)
  crown.rotateZ(Math.PI / 2)
  crown.translate(11.9, 2, 0)
  parts.push(crown)
  return mergeParts(parts)
}

function scalpelGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const handle = tint(new THREE.BoxGeometry(26, 2, 3.6), '#4A443C')
  handle.translate(-12, 1, 0)
  parts.push(handle)
  const grip = tint(new THREE.BoxGeometry(6, 2.3, 4), '#3A352F')
  grip.translate(-2, 1.15, 0)
  parts.push(grip)
  // blade: flat extruded profile — curved belly rising to the point
  const s = new THREE.Shape()
  s.moveTo(0, -1.6)
  s.lineTo(12, -1.8)
  s.quadraticCurveTo(19, -1.4, 22, 0.6)
  s.quadraticCurveTo(16, 1.6, 10, 1.7)
  s.lineTo(0, 1.6)
  s.closePath()
  const blade = new THREE.ExtrudeGeometry(s, { depth: 0.9, bevelEnabled: false, curveSegments: 5 })
  blade.rotateX(-Math.PI / 2) // lie flat, thickness on Y
  const bladeIdx = tint(mergeVertices(blade), '#C7CBD1')
  bladeIdx.translate(1, 0.6, 0)
  parts.push(bladeIdx)
  return mergeParts(parts)
}

/** Every leaf archetype shares the same material contract.
 * `forbid` widens for a CLUMP by the largest deviation its rows take from
 * {0, π}, so the depth-axis fence holds for every blade the clump carries and
 * not merely for the instance's own yaw (see `mapleClumpFence`). */
function leafArchetype(geometry: THREE.BufferGeometry, forbid = LEAF_YAW_FORBID): ArchetypeGeom {
  // the blades were built from the Blender asset iff it carries UVs — then the
  // archetype wears the asset's detail + vein maps on a two-sided surface
  const asset = geometry.getAttribute('uv') ? decorAsset('maple-leaf') : null
  return {
    geometry,
    color: '#FFFFFF',
    groundOffset: 0,
    roughness: asset ? asset.roughness : 0.6,
    scatter: forbid === LEAF_YAW_FORBID ? LEAF_SCATTER : { ...LEAF_SCATTER, forbid },
    contactDecal: true,
    castsShadow: false,
    map: asset?.map ?? null,
    normalMap: asset?.normalMap ?? null,
    normalScale: asset?.normalScale ?? null,
    doubleSided: asset !== null,
  }
}

/** A clump archetype: geometry + the fence its own rows require. */
function leafClumpArchetype(kind: LeafClumpKind, surfaceY: number): ArchetypeGeom {
  return leafArchetype(mapleClumpGeom(kind, surfaceY), mapleClumpFence(kind))
}

const SILHOUETTES: Record<string, () => ArchetypeGeom> = {
  'person-standing': () => ({ geometry: personGeom('standing'), color: '#FFFFFF', groundOffset: 0 }),
  'person-standing-b': () => ({ geometry: personGeom('standing-b'), color: '#FFFFFF', groundOffset: 0 }),
  'person-pointing': () => ({ geometry: personGeom('pointing'), color: '#FFFFFF', groundOffset: 0 }),
  'person-pair': () => ({ geometry: personGeom('pair'), color: '#FFFFFF', groundOffset: 0 }),
  'server-rack': () => ({ geometry: serverRackGeom(), color: '#FFFFFF', groundOffset: 0 }),
  'cable-spool': () => ({ geometry: cableSpoolGeom(), color: '#FFFFFF', groundOffset: 0 }),
  'supply-crate': () => ({ geometry: crateGeom(), color: '#FFFFFF', groundOffset: 0 }),
  'tree-round': () => ({ geometry: treeGeom(false), color: '#FFFFFF', groundOffset: 0 }),
  'tree-tall': () => ({ geometry: treeGeom(true), color: '#FFFFFF', groundOffset: 0 }),
  'planter-shrub': () => ({ geometry: planterGeom(), color: '#FFFFFF', groundOffset: 0 }),
  // quality pass "cntower" ("chunky faceted hex, flat untextured ferrule,
  // plain eraser"): the Blender pencil (desk_tools_assets.py) — a bevelled
  // hex with a stamped top flat, a crimped brass ferrule, a pink eraser and
  // a sharpened cone cut exactly through the hex (the six lacquer scallops),
  // cedar grain and a graphite point — on the fallback's 101-unit gabarit,
  // seated on its bottom flat at y = 0. The mug's print × COLOR_0 contract:
  // no new shader program.
  'desk-pencil': () => {
    const asset = decorAsset('desk-pencil')
    if (asset) return { geometry: asset.geometry, color: '#FFFFFF', groundOffset: 0.05, roughness: asset.roughness, map: asset.map }
    return { geometry: pencilGeom(), color: '#FFFFFF', groundOffset: 3.4 }
  },
  // ×DESK_PROP_GROWTH (loop 4: "the coil is a grey ring at (1210,355)")
  // …and centred on its plan box, so the plug's reach stays inside the
  // rotation-safe footprint (registry.ts) instead of hanging 34 units off a
  // coil-centred origin. Quality pass "cntower" ("a placeholder donut: a
  // single smooth torus, no wire turns, no plug"): the Blender coil — four
  // braided turns wound in a 2 x 2 bundle, a red hook-and-loop tie, a tail
  // out to a two-prong plug — authored at the grown size (plan radius 34.4,
  // under the same 36 footprint) and centred the same way.
  'desk-cable-coil': () => {
    const asset = decorAsset('desk-cable-coil')
    if (asset) return { geometry: asset.geometry, color: '#FFFFFF', groundOffset: 0.05, roughness: asset.roughness, map: asset.map }
    return {
      geometry: centreXZ(cableCoilGeom().scale(DESK_PROP_GROWTH, DESK_PROP_GROWTH, DESK_PROP_GROWTH)),
      color: '#FFFFFF',
      groundOffset: 2.4 * DESK_PROP_GROWTH,
    }
  },
  'desk-note': () => {
    // loop 4: "a 15 px white square with a placeholder '!!!'" — the Blender
    // cards (desk_assets.py): blue ruling, a red margin, handwriting-like
    // scribbles and a box-and-arrow sketch printed on a curled index card
    const asset = decorAsset('desk-note')
    if (asset) {
      return {
        geometry: asset.geometry,
        color: '#FFFFFF',
        // the lower card is a zero-thickness sheet at y = 0: lift it clear of
        // the desk plane (no z-fight) — 0.25 is 0.06 mm at 4.1 units/cm
        groundOffset: 0.25,
        roughness: asset.roughness,
        map: asset.map,
        doubleSided: true, // the curled corner shows its back
        // the writing faces the reader: the card's text-up axis (local −Z)
        // turns to the camera's look direction, ±NOTE_YAW_SPREAD — a free
        // yaw left the handwriting upside down in loop4-r1-assets4
        // /workbench-desk-note.png
        yawBand: NOTE_YAW_BAND,
      }
    }
    return { geometry: deskNoteGeom(), color: '#FFFFFF', groundOffset: 0 }
  },
  'desk-mug': () => {
    // loop 4 hero desk object: the enamel camp mug with the official leaf
    const asset = decorAsset('desk-mug')
    if (asset) {
      return { geometry: asset.geometry, color: '#FFFFFF', groundOffset: 0.05, roughness: asset.roughness, map: asset.map }
    }
    return { geometry: mugGeom(), color: '#FFFFFF', groundOffset: 0.05, roughness: 0.32 }
  },
  // loop 4 r2 near-field anchors ("the desk around the board is mostly
  // empty"): Blender props (desk_assets.py) on the mug's material contract —
  // print × COLOR_0, single-sided — so they share its shader program
  'desk-notebooks': () => {
    const asset = decorAsset('desk-notebooks')
    if (asset) return { geometry: asset.geometry, color: '#FFFFFF', groundOffset: 0.05, roughness: asset.roughness, map: asset.map }
    return { geometry: notebooksGeom(), color: '#FFFFFF', groundOffset: 0.05, roughness: 0.7 }
  },
  'desk-plant': () => {
    const asset = decorAsset('desk-plant')
    if (asset) return { geometry: asset.geometry, color: '#FFFFFF', groundOffset: 0.05, roughness: asset.roughness, map: asset.map }
    return { geometry: plantGeom(), color: '#FFFFFF', groundOffset: 0.05, roughness: 0.8 }
  },
  // loop 4 r3 far-band anchors ("the whole far desk band is bare streaked
  // wood"): the same print × COLOR_0 contract, so no new shader program
  'desk-pencil-cup': () => {
    const asset = decorAsset('desk-pencil-cup')
    if (asset) return { geometry: asset.geometry, color: '#FFFFFF', groundOffset: 0.05, roughness: asset.roughness, map: asset.map }
    return { geometry: pencilCupGeom(), color: '#FFFFFF', groundOffset: 0.05, roughness: 0.55 }
  },
  'desk-books': () => {
    const asset = decorAsset('desk-books')
    if (asset) return { geometry: asset.geometry, color: '#FFFFFF', groundOffset: 0.05, roughness: asset.roughness, map: asset.map }
    return { geometry: booksGeom(), color: '#FFFFFF', groundOffset: 0.05, roughness: 0.72 }
  },
  // loop 4 r4 mid-size gap fillers ("the scattered small objects read as
  // debris rather than a lived-in desk"): the same print × COLOR_0 contract
  'desk-sketchbook': () => {
    const asset = decorAsset('desk-sketchbook')
    // the drawing faces the reader like the index cards' writing (page top =
    // local −Z, the cards' text-up axis)
    if (asset) return { geometry: asset.geometry, color: '#FFFFFF', groundOffset: 0.05, roughness: asset.roughness, map: asset.map, yawBand: NOTE_YAW_BAND }
    return { geometry: sketchbookGeom(), color: '#FFFFFF', groundOffset: 0.05, roughness: 0.8, yawBand: NOTE_YAW_BAND }
  },
  'desk-blueprint': () => {
    const asset = decorAsset('desk-blueprint')
    if (asset) return { geometry: asset.geometry, color: '#FFFFFF', groundOffset: 0.05, roughness: asset.roughness, map: asset.map }
    return { geometry: blueprintGeom(), color: '#FFFFFF', groundOffset: 0.05, roughness: 0.75 }
  },
  'person-walking': () => ({ geometry: personGeom('walking'), color: '#FFFFFF', groundOffset: 0 }),
  'person-carrying': () => ({ geometry: personGeom('carrying'), color: '#FFFFFF', groundOffset: 0 }),
  'moose': () => {
    // view3d quality loop 4 r2 ("a blocky toy: box body, box head, four stick
    // legs, flat plank antlers"): the Blender bull (wildlife_assets.py) — a
    // metaball sculpt with the shoulder hump, deep chest, slim hindquarters,
    // jointed legs (knee/hock, pale stockings, dark cloven hooves), the long
    // drooping muzzle, the bell, ears, and tapered palmate antlers with six
    // tines a side. The SAME material contract as the beaver (COLOR_0 ×
    // detail map, normal map, MR map), so it links no new shader program.
    // mooseGeom() below stays the fallback until the GLB arrives.
    const asset = decorAsset('moose')
    if (asset) {
      return {
        geometry: asset.geometry,
        color: '#FFFFFF',
        groundOffset: CITY_PAVING_CLEAR,
        roughness: asset.roughness,
        map: asset.map,
        normalMap: asset.normalMap,
        normalScale: asset.normalScale ?? null,
        metalRoughMap: asset.metalRoughMap ?? null,
        metalness: asset.metalness ?? 0,
      }
    }
    return { geometry: mooseGeom(), color: '#FFFFFF', groundOffset: 0 }
  },
  'beaver': () => {
    // view3d quality loop 4 ("a two-sphere blob with a paddle: no face, legs,
    // incisors or fur"): the Blender beaver (scripts/blender/wildlife_assets.py)
    // — a sitting, hunched sculpt gnawing a stick, with eyes, nose, orange
    // incisors, forepaws, webbed hind feet and a scaled tail; the fur
    // countershade rides COLOR_0, the clumps and scales the detail/normal
    // maps, the glossy eyes and nose the MR map. The procedural blob below
    // stays the fallback until the GLB arrives (glbAssets.ts contract).
    const asset = decorAsset('beaver')
    if (asset) {
      return {
        geometry: asset.geometry,
        color: '#FFFFFF',
        // seated like the flag: no city paving plane cuts across the feet
        groundOffset: CITY_PAVING_CLEAR,
        roughness: asset.roughness,
        map: asset.map,
        normalMap: asset.normalMap,
        normalScale: asset.normalScale ?? null,
        metalRoughMap: asset.metalRoughMap ?? null,
        metalness: asset.metalness ?? 0,
      }
    }
    return { geometry: beaverGeom(), color: '#FFFFFF', groundOffset: 0.5 }
  },
  'loon': () => ({ geometry: loonGeom(), color: '#FFFFFF', groundOffset: 0.1 }),
  'ranger-hat': () => ({
    geometry: rangerHatGeom().scale(DESK_PROP_GROWTH, DESK_PROP_GROWTH, DESK_PROP_GROWTH),
    color: '#FFFFFF',
    groundOffset: 0,
  }),
  // roughness 0.6 (vs the clay 0.85): a leaf is a waxy blade, not clay, and
  // the sheen is half of what separates a flat cutout from the surface it lies
  // on. Every leaf archetype carries `contactDecal` (drawn grounding shadow,
  // RGBA vertex colours, transparent material with depthWrite off) and clears
  // `castsShadow` — see the `contactShadowGeom` block. DESK archetypes seat
  // their decal on CITY_PAVING_CLEAR so no city paving plane cuts across it.
  'maple-leaf-cluster': () => leafClumpArchetype('cluster', CITY_PAVING_CLEAR),
  // the BOARD clumps — leaves clumped in loose drifts, several per board.
  'maple-leaf-drift': () => leafClumpArchetype('drift', 0),
  'maple-leaf-pair': () => leafClumpArchetype('pair', 0),
  'maple-leaf-pair-b': () => leafClumpArchetype('pairB', 0),
  // …and the one that banks against a cable run.
  'maple-leaf-bank': () => leafClumpArchetype('bank', 0),
  // the DESK singles — the SMALLER blades (a desk cell may sit only 10 units
  // outside the slab, so a big desk blade reaches back over the
  // board rim and is sliced by it; the board's own 30-unit rule is provable).
  'maple-leaf-fall': () => leafArchetype(mapleLeafSingleGeom('fall', CITY_PAVING_CLEAR)),
  'maple-leaf-fall-b': () => leafArchetype(mapleLeafSingleGeom('fallB', CITY_PAVING_CLEAR)),
  // the BOARD singles — the HERO blade and its two partners, sized against
  // LEAF_BOARD_R_MAX, which is what keeps a yawed blade off the slab bevel.
  'maple-leaf-mini': () => leafArchetype(mapleLeafSingleGeom('mini', 0)),
  'maple-leaf-mini-b': () => leafArchetype(mapleLeafSingleGeom('miniB', 0)),
  'maple-leaf-mini-c': () => leafArchetype(mapleLeafSingleGeom('miniC', 0)),
  'canada-flag': () => {
    // USER ASK 2026-10-08 ("the flag lacks realism, it does not look like
    // it"): the Blender flag — the OFFICIAL 11-point leaf printed on a
    // cloth-relaxed banner, steel pole, brass finial, bevelled foot — on the
    // same FLAG gabarit as the procedural one below, which stays the fallback
    // until the GLB arrives.
    const asset = decorAsset('canada-flag')
    if (asset) {
      return {
        geometry: asset.geometry,
        color: '#FFFFFF',
        groundOffset: CITY_PAVING_CLEAR,
        roughness: asset.roughness,
        yawBand: FLAG_YAW_BAND,
        map: asset.map,
        // brushed-steel pole, brass finial and foot (loop 3 r2: "a grey
        // plastic toy") — the finish per part is the asset's MR map
        metalRoughMap: asset.metalRoughMap ?? null,
        metalness: asset.metalness ?? 0,
        doubleSided: true,
      }
    }
    return {
      geometry: canadaFlagGeom(),
      color: '#FFFFFF',
      // round 8 #3: the foot seats on the city paving clearance, so no paving
      // plane can cut across the base plate or the bottom of the pole
      groundOffset: CITY_PAVING_CLEAR,
      roughness: 0.75,
      yawBand: FLAG_YAW_BAND,
    }
  },
  // quality pass "cntower" ("an untextured featureless white cone that
  // dominates the frame"): the Blender souvenir (desk_tools_assets.py) — the
  // Y base's three legs round a slim core, the main pod's white skirt and two
  // glass bands, the SkyPod, the mast, slip-form banding on light concrete,
  // on a granite plinth; 123.4 tall (was 281). Same print × COLOR_0 contract.
  'cn-tower': () => {
    const asset = decorAsset('cn-tower')
    if (asset) return { geometry: asset.geometry, color: '#FFFFFF', groundOffset: 0.05, roughness: asset.roughness, map: asset.map }
    return { geometry: cnTowerGeom(), color: '#FFFFFF', groundOffset: 0.05, roughness: 0.6 }
  },
  'compass': () => ({ geometry: compassGeom(), color: '#FFFFFF', groundOffset: 0 }),
  'scalpel': () => ({ geometry: scalpelGeom(), color: '#FFFFFF', groundOffset: 0 }),
}

/** Every buildable archetype id (test gate: registry ids ⊆ this catalog). */
export const SILHOUETTE_IDS: readonly string[] = Object.keys(SILHOUETTES)

let geomCacheAssetVersion = -1

function archetypeGeom(id: string): ArchetypeGeom | null {
  if (geomCacheAssetVersion !== decorAssetsVersion()) {
    // a Blender asset arrived: every silhouette built from the fallback is
    // stale. The previous build's meshes are torn down by the same rebuild
    // that asks for the new silhouettes, so releasing their GPU buffers here
    // is safe (a stray render would simply re-upload).
    for (const [, g] of geomCache) g.geometry.dispose()
    geomCache.clear()
    geomCacheAssetVersion = decorAssetsVersion()
  }
  const hit = geomCache.get(id)
  if (hit) return hit
  const make = SILHOUETTES[id]
  if (!make) return null
  const made = make()
  geomCache.set(id, made)
  return made
}

// ── CONTACT BLOBS (view3d quality, contact pass 2026-10-09) ────────────────
//
// The critic: "props barely ground themselves: the flag base, moose hooves,
// leaves and mug base lack visible contact shadows or AO; leaves look like
// decals". Two causes, measured with a live shadow-map probe (never committed):
//
//  1. 8 of 23 workbench props stood OUTSIDE the sun's shadow camera, which was
//     fitted to the content bounds only — fixed at the root in
//     lit/lighting.ts (`fitShadowCamera`'s `cover`);
//  2. the props INSIDE it do cast, but the key light is 38° up at −55°, so a
//     mug's or a flag foot's shadow falls BEHIND the prop from the default
//     iso camera — toggling the sun's castShadow changed 1.06% of the frame,
//     nearly all of it on the board (cards, drums). Nothing darkens the
//     ground at the base, all around, which is what reads as contact.
//
// So every placed prop gets ONE contact shadow. A leaf archetype's is its own
// drawn decal (below); every other prop's is ONE soft blob: a quad under its
// CONTACT footprint (the bounding rect of the vertices in its lowest band —
// hooves, a mug's base ring, the flag's foot, a whole low book stack), grown
// by CONTACT_BLOB_GROW, elongated and yawed with the prop, and pushed a little
// along the key light's throw. All blobs of a build are ONE merged mesh, ONE
// MeshBasicMaterial (black-ish colour × a shared alpha map, transparent,
// depthWrite off, polygonOffset toward the camera): one draw call, and the
// material set is the drum pad's existing SDF blob (Scene3D buildStandee:
// color + alphaMap + transparent + depthWrite off + toneMapped off), so the
// program is one the board already links. It never casts or receives.
//
// The alpha map is a 128 × 128 atlas of four 64-px cells generated once, in
// plain math (no DOM, so the gates can read it). Columns: a DISC for round
// feet (a mug, a pot, the flag's foot) and a SQUIRCLE for boxy footprints
// (books, a note, a moose's four hooves). Rows: a TALL prop's wide soft pool
// and a LOW prop's tight rim (a book stack is not a mug: its shadow hugs it).
// Strength is baked into the texels because the host's morph fade drives
// every decor material's `opacity` (regFloorFade).
//
// The LEAVES are not in it. Each blade already carries its own drawn decal
// (`contactShadowGeom`), one per blade rather than one per clump — a single
// pool under a whole pile darkened the gaps between the blades into one
// stain (.probes/contact red-tint pass, maple-leaf-cluster). That decal is
// their contact shadow; this pass made it visible (LEAF_SHADOW_ALPHA).

/** Quad half-extent / contact half-extent, and the ρ where the falloff
 * starts, per row. TALL: the footprint edge sits at ρ = 1/1.7 = 0.59 of the
 * quad, where α is still 0.56 (contactBlobAlpha), and the pool fades to 0
 * 0.7 footprints further out. Two cuts were too thin to read, measured on the
 * probe close-ups: 1.35 / α 0.55 / knee 0.6 (α 0.34 at the edge, gone 0.35
 * footprints out — a hairline at the fit framing, .probes/contact/
 * crop-wide.png) and 1.5 / 0.6 / 0.5 (crop-flag.png: the flag foot's ring
 * indistinguishable from its own dark rubber skirt). LOW: edge at ρ = 0.82,
 * α 0.55, gone a fifth of a footprint out. */
export const CONTACT_BLOB_GROW = { tall: 1.7, low: 1.22 } as const
const CONTACT_BLOB_KNEE = { tall: 0.45, low: 0.8 } as const
/** Alpha at the blob's plateau (under the prop, mostly hidden by it). */
export const CONTACT_BLOB_ALPHA = 0.6
/** A prop is LOW when its opaque height is at most its contact half-extent. */
const LOW_HEIGHT_PER_R = 1
/** The atlas: 2 × 2 square cells. */
export const CONTACT_BLOB_TEX_W = 128
export const CONTACT_BLOB_TEX_H = 128
const CELL = 64
/** A footprint is ROUND when max(|u| + |v|) over its contact vertices (u, v
 * normalised to its half-extents) stays under this: a disc's is √2 = 1.41, a
 * filled rectangle's 2. */
const ROUND_L1_MAX = 1.7
/** The contact band: vertices within this share of the opaque height above
 * the lowest one. A FLAT prop (height ≤ CONTACT_FLAT × its plan extent: a
 * leaf, a note, the sketchbook) uses all of its vertices. */
const CONTACT_BAND = 0.2
const CONTACT_FLAT = 0.3
/** The throw along the key light, per unit of prop height, capped at a share
 * of the footprint radius: a contact shadow leans, it does not travel. */
const CONTACT_THROW_PER_H = 0.06
const CONTACT_THROW_MAX = 0.22
/** Warm near-black: the desk's shadow tone, not neutral grey. */
const CONTACT_BLOB_COLOR = '#1E140C'

let contactBlobTex: THREE.DataTexture | null = null

/** α of the blob at normalised radius ρ (0 centre, 1 quad rim). */
export function contactBlobAlpha(rho: number, row: 'tall' | 'low' = 'tall'): number {
  if (rho >= 1) return 0
  const knee = CONTACT_BLOB_KNEE[row]
  const t = Math.min(1, Math.max(0, (rho - knee) / (1 - knee)))
  return CONTACT_BLOB_ALPHA * (1 - t * t * (3 - 2 * t))
}

/** The shared alpha atlas (generated once per page; GPU copy released by
 * `disposeDecorGeometries`). alphaMap reads the GREEN channel. Cell (col,
 * row): col 0 disc / 1 squircle, row 0 tall / 1 low — UV origin bottom-left,
 * DataTexture rows bottom-up (flipY false). */
export function contactBlobTexture(): THREE.DataTexture {
  if (contactBlobTex) return contactBlobTex
  const W = CONTACT_BLOB_TEX_W
  const H = CONTACT_BLOB_TEX_H
  const data = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const col = x < CELL ? 0 : 1
      const row = y < CELL ? 'tall' : 'low'
      // texel centre in the cell's [-1, 1]²
      const u = (((x % CELL) + 0.5) / CELL) * 2 - 1
      const v = (((y % CELL) + 0.5) / CELL) * 2 - 1
      const rho = col === 0 ? Math.hypot(u, v) : Math.pow(u ** 4 + v ** 4, 0.25)
      const a = Math.round(255 * contactBlobAlpha(rho, row))
      const o = (y * W + x) * 4
      data[o] = a
      data[o + 1] = a
      data[o + 2] = a
      data[o + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  contactBlobTex = tex
  return tex
}

/** An archetype's CONTACT footprint in its own frame. */
export interface ContactFootprint {
  cx: number
  cz: number
  hx: number
  hz: number
  /** Lowest opaque vertex, and the opaque height above it. */
  minY: number
  height: number
  round: boolean
  /** Height ≤ LOW_HEIGHT_PER_R × contact half-extent: the tight-rim row. */
  low: boolean
}

const footprintCache = new WeakMap<THREE.BufferGeometry, ContactFootprint>()

/** The footprint of what TOUCHES the surface. A drawn leaf decal (RGBA colour,
 * α < 1) is a shadow, not the blade — it is skipped. */
export function contactFootprint(geo: THREE.BufferGeometry): ContactFootprint {
  const hit = footprintCache.get(geo)
  if (hit) return hit
  const pos = geo.getAttribute('position')
  const col = geo.getAttribute('color')
  const decal = col && col.itemSize === 4
  const opaque = (i: number) => !decal || col.getW(i) >= 0.999
  let minY = Infinity
  let maxY = -Infinity
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (let i = 0; i < pos.count; i++) {
    if (!opaque(i)) continue
    const y = pos.getY(i)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
    x0 = Math.min(x0, pos.getX(i))
    x1 = Math.max(x1, pos.getX(i))
    z0 = Math.min(z0, pos.getZ(i))
    z1 = Math.max(z1, pos.getZ(i))
  }
  const height = maxY - minY
  const flat = height <= CONTACT_FLAT * Math.max(x1 - x0, z1 - z0)
  const top = flat ? Infinity : minY + CONTACT_BAND * height
  x0 = Infinity
  x1 = -Infinity
  z0 = Infinity
  z1 = -Infinity
  for (let i = 0; i < pos.count; i++) {
    if (!opaque(i) || pos.getY(i) > top) continue
    x0 = Math.min(x0, pos.getX(i))
    x1 = Math.max(x1, pos.getX(i))
    z0 = Math.min(z0, pos.getZ(i))
    z1 = Math.max(z1, pos.getZ(i))
  }
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  // a pencil's contact is a line: keep the blob at least an eighth as wide as
  // it is long, or it renders as a hairline (a fifth read as a wide smear
  // along the pencil in the red-tint probe)
  const r = Math.max(x1 - x0, z1 - z0) / 2
  const hx = Math.max((x1 - x0) / 2, 0.125 * r, 1e-3)
  const hz = Math.max((z1 - z0) / 2, 0.125 * r, 1e-3)
  let l1 = 0
  for (let i = 0; i < pos.count; i++) {
    if (!opaque(i) || pos.getY(i) > top) continue
    l1 = Math.max(l1, Math.abs(pos.getX(i) - cx) / hx + Math.abs(pos.getZ(i) - cz) / hz)
  }
  const fp = { cx, cz, hx, hz, minY, height, round: l1 <= ROUND_L1_MAX, low: height <= LOW_HEIGHT_PER_R * Math.max(hx, hz) }
  footprintCache.set(geo, fp)
  return fp
}

/** One blob quad, appended to the merged arrays: the footprint rect's corners
 * through the instance's own matrix (yaw, tilt, scale), grown about their
 * centre, thrown along the key light, flattened onto `y`. */
function pushContactBlob(
  out: { pos: number[]; uv: number[]; idx: number[] },
  fp: ContactFootprint,
  m: THREE.Matrix4,
  scale: number,
  y: number,
): void {
  const c = new THREE.Vector3(fp.cx, fp.minY, fp.cz).applyMatrix4(m)
  const r = Math.max(fp.hx, fp.hz) * scale
  const throwLen = Math.min(CONTACT_THROW_MAX * r, CONTACT_THROW_PER_H * fp.height * scale)
  const tx = SUN_XZ[0] * throwLen
  const tz = SUN_XZ[1] * throwLen
  const base = out.pos.length / 3
  const u0 = fp.round ? 0 : 0.5
  const v0 = fp.low ? 0.5 : 0
  const grow = CONTACT_BLOB_GROW[fp.low ? 'low' : 'tall']
  const corner = new THREE.Vector3()
  for (const [a, b] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    corner.set(fp.cx + a * fp.hx, fp.minY, fp.cz + b * fp.hz).applyMatrix4(m)
    out.pos.push(c.x + (corner.x - c.x) * grow + tx, y, c.z + (corner.z - c.z) * grow + tz)
    out.uv.push(u0 + (a + 1) / 4, v0 + (b + 1) / 4)
  }
  // wound to face +Y whatever the instance's handedness (a mirrored corner
  // order would cull the quad)
  const p = out.pos
  const e1x = p[(base + 1) * 3] - p[base * 3]
  const e1z = p[(base + 1) * 3 + 2] - p[base * 3 + 2]
  const e2x = p[(base + 2) * 3] - p[base * 3]
  const e2z = p[(base + 2) * 3 + 2] - p[base * 3 + 2]
  const upFacing = e1z * e2x - e1x * e2z > 0 // (e1 × e2).y
  if (upFacing) out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  else out.idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
}

/**
 * Build the pack's instanced meshes from a placement result.
 * `lit` picks the material family; decor is a scene garnish, so props cast
 * shadows under the lit profile (the "miniature figures on the board" cue)
 * but never receive-only.
 */
export function buildDecorMeshes(
  pack: DecorPackMeta,
  placed: PlacedProp[],
  opts: { lit: boolean; platformLift?: number; deskLift?: number },
): DecorBuildResult {
  const group = new THREE.Group()
  const counts: Record<string, number> = {}
  const materials: THREE.Material[] = []
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const qTilt = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const tiltAxis = new THREE.Vector3()
  const v3 = new THREE.Vector3()
  const scl = new THREE.Vector3()
  const pos = new THREE.Vector3()

  const geometries: THREE.BufferGeometry[] = []
  // lit only: the unlit profile has no shadows for a blob to stand in for
  const blobs = opts.lit ? { pos: [] as number[], uv: [] as number[], idx: [] as number[], props: [] as string[] } : null

  // the host merges pack + shared desk archetypes, and packs may carry their
  // own copy of a shared desk id (canadiana's beaver / maple-leaf-cluster) —
  // dedupe so an id never builds two overlapping meshes
  const built = new Set<string>()
  for (const a of pack.archetypes) {
    if (built.has(a.id)) continue
    built.add(a.id)
    const items = placed.filter((p) => p.archetypeId === a.id)
    if (items.length === 0) continue
    const src = archetypeGeom(a.id)
    if (!src) continue
    // `contactDecal` archetypes carry an RGBA colour attribute whose alpha is
    // the drawn grounding shadow. THREE enables USE_COLOR_ALPHA on its own for
    // a 4-component attribute, but only a TRANSPARENT material blends it — and
    // depthWrite has to go with it, or the decal's α = 0 rim would punch
    // invisible holes in whatever is drawn behind it (see `contactShadowGeom`).
    const alpha = src.contactDecal === true
    const side = src.doubleSided ? THREE.DoubleSide : THREE.FrontSide
    const material = opts.lit
      ? new THREE.MeshStandardMaterial({
          color: src.color,
          roughness: src.roughness ?? 0.85,
          metalness: src.metalRoughMap ? (src.metalness ?? 1) : 0,
          roughnessMap: src.metalRoughMap ?? null,
          metalnessMap: src.metalRoughMap ?? null,
          vertexColors: true,
          transparent: alpha,
          depthWrite: !alpha,
          map: src.map ?? null,
          normalMap: src.normalMap ?? null,
          ...(src.normalMap && src.normalScale ? { normalScale: src.normalScale.clone() } : {}),
          side,
        })
      : new THREE.MeshBasicMaterial({
          color: src.color,
          toneMapped: false,
          vertexColors: true,
          transparent: alpha,
          depthWrite: !alpha,
          map: src.map ?? null,
          side,
        })
    materials.push(material)
    const mesh = new THREE.InstancedMesh(src.geometry, material, items.length)
    // the scatter pose re-seats every instance EXACTLY (see below), which needs
    // the archetype's own vertices and its untilted contact height
    const vtx = src.scatter ? (src.geometry.getAttribute('position') as THREE.BufferAttribute) : null
    let baseMinY = 0
    if (vtx) {
      src.geometry.computeBoundingBox()
      baseMinY = src.geometry.boundingBox!.min.y
    }
    if (!src.geometry.boundingBox) src.geometry.computeBoundingBox()
    const fullMinY = src.geometry.boundingBox!.min.y
    for (let i = 0; i < items.length; i++) {
      const p = items[i]
      let seat = 0
      if (src.scatter && vtx) {
        // FALLEN LITTER: a fenced yaw plus an out-of-plane
        // tilt whose direction is drawn from an arc about the viewer, both pure
        // functions of the placement's propId. Yaw first, then tilt, because
        // the cant is a WORLD direction and must not turn with the blade:
        // q = qTilt · qYaw.
        const sp = scatterPoseOf(p.propId, src.scatter)
        q.setFromAxisAngle(up, sp.yaw)
        qTilt.setFromAxisAngle(tiltAxis.copy(sp.axis), sp.tilt)
        q.premultiply(qTilt)
        // …and RE-SEAT. Tilting a body that sits above its own origin swings
        // part of it below the contact plane (and, when the low corner happens
        // to swing UP, above it — a clump is a pile, so both really happen).
        // The correction is the exact displacement of the LOWEST vertex under
        // the composed rotation, signed: it puts the instance's contact point
        // back exactly where the untilted archetype seated it, which is what
        // preserves CITY_PAVING_CLEAR for the desk props and DECAL_CLEAR
        // for the board leaves whatever pose is drawn. A bounding-radius
        // estimate would leave a propped blade hovering a third of its radius
        // clear of the surface. One pass over the archetype's vertices per
        // instance; leaf archetypes are ~2k vertices and ≤6 instances each.
        let minY = Infinity
        for (let k = 0; k < vtx.count; k++) {
          const y = v3.fromBufferAttribute(vtx, k).applyQuaternion(q).y
          if (y < minY) minY = y
        }
        seat = (baseMinY - minY) * p.scale + SCATTER_SEAT_EPS
      } else {
        // the desk flag folds its free yaw onto the broadside band; every
        // other archetype keeps the placement's rotation verbatim
        q.setFromAxisAngle(up, src.yawBand ? bandYaw(p.rotY, src.yawBand) : p.rotY)
      }
      // platform props stand ON the pedestal (figurines between the shapes),
      // board props on the paper, desk props drop to
      // the workbench level outside the slab
      pos.set(
        p.x,
        src.groundOffset + seat + (p.onDesk ? opts.deskLift ?? 0 : p.onPlatform ? opts.platformLift ?? 0 : 0),
        p.z,
      )
      scl.setScalar(p.scale)
      m4.compose(pos, q, scl)
      mesh.setMatrixAt(i, m4)
      // a drawn-decal archetype (the leaves) already carries its contact
      // shadow, one per blade — see the CONTACT BLOBS block
      if (blobs && !alpha) {
        // just under the prop's lowest point, never into the surface it
        // stands on: the desk's cutting mat lies 0.12 over the desk plane,
        // which is deskLift − 0.3 (Scene3D)
        const ref = p.onDesk ? opts.deskLift ?? 0 : p.onPlatform ? opts.platformLift ?? 0 : 0
        const base = ref + src.groundOffset + fullMinY * p.scale
        // (desk floor 0.18 over the plane: the pencil's barrel bottoms out at
        // 0.2 — build.test's "under the prop" gate measured 0.02 above it at
        // a 0.22 floor)
        const y = Math.max(base - CONTACT_BLOB_UNDER, ref + (p.onDesk ? -0.12 : 0.1))
        pushContactBlob(blobs, contactFootprint(src.geometry), m4, p.scale, y)
        blobs.props.push(p.propId)
      }
    }
    mesh.instanceMatrix.needsUpdate = true
    if (opts.lit) {
      // a 0.4-unit-thick blade contributes nothing under the sun's 1.5-unit
      // normalBias, and its DECAL must never be rasterised into the shadow map
      mesh.castShadow = src.castsShadow !== false
      mesh.receiveShadow = true
    }
    // cache-owned geometry: clearRoot must not dispose it (pack switches and
    // rebuilds reuse the silhouette); disposeDecorBuild owns materials.
    mesh.userData.sharedAsset = true
    mesh.userData.decorArchetype = a.id
    mesh.userData.decorCount = items.length
    counts[a.id] = items.length
    group.add(mesh)
  }
  if (blobs && blobs.props.length > 0) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(blobs.pos, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(blobs.uv, 2))
    // unused by an unlit material, but `!!geometry.attributes.normal` is a
    // bit of three's program key (vertexNormals): without it the blob linked
    // a program of its own beside the drum pad's identical SDF blob
    // (.probes/contact probe, cacheKey bit 23: 52 programs vs 51)
    const nrm = new Float32Array(blobs.pos.length)
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
    geo.setIndex(blobs.idx)
    const material = new THREE.MeshBasicMaterial({
      color: CONTACT_BLOB_COLOR,
      alphaMap: contactBlobTexture(),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      // pulled toward the camera: the blob lies a fraction of a unit over the
      // desk / mat / board, which a far zoom cannot resolve on depth alone
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    })
    const mesh = new THREE.Mesh(geo, material)
    mesh.castShadow = false
    mesh.receiveShadow = false
    // after the desk vignette (−12) and the board's SDF shadows (−11), before
    // every other transparent pass — the leaves' blades and decals (0) paint
    // OVER their blob, never under it
    mesh.renderOrder = -1
    mesh.userData.decorContactBlobs = blobs.props.length
    mesh.userData.decorContactProps = blobs.props
    materials.push(material)
    geometries.push(geo)
    group.add(mesh)
  }
  return { group, counts, materials, geometries }
}

/** How far under a prop's lowest point its blob is drawn. */
const CONTACT_BLOB_UNDER = 0.12

/** Dispose a build's materials and its own (non-cached) geometry. */
export function disposeDecorBuild(result: DecorBuildResult): void {
  for (const m of result.materials) m.dispose()
  for (const g of result.geometries) g.dispose()
}

/** Drop the silhouette cache (scene dispose — leak accounting). */
export function disposeDecorGeometries(): void {
  for (const [, g] of geomCache) g.geometry.dispose()
  geomCache.clear()
  // the GPU copy only — the texture object stays valid and re-uploads
  contactBlobTex?.dispose()
}
