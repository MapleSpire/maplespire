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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { Lighting3D } from '../specs'
import { compileAndWait } from './compileSafe'

/**
 * The LIT render profile's light rig (PBR theme-by-theme migration).
 *
 * Topology is FIXED by design: one directional key ("sun") + one hemisphere
 * fill + a procedural IBL environment (PMREM of RoomEnvironment — zero asset
 * bytes). Themes tune parameters through the sanitized `Lighting3D` block;
 * they can never add lights, so the GPU cost of a lit theme is bounded and a
 * hostile config cannot multiply passes.
 *
 * Lifecycle contract (leak gates): the rig and the PMREM environment are
 * created ONCE per profile activation — `Scene3D.applyRenderProfile()` calls
 * `mountLightRig`/`acquireRoomEnvironment` when a lit theme lands and the
 * matching dispose/release when it leaves (or on Scene3D.dispose). Rebuilds
 * MUST NOT churn these: the hardening drills assert a flat allocation plateau.
 */

export interface LightRig {
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  /** The sun's unit direction (toward the light) as the theme set it — the
   * ONE source `fitShadowCamera` re-anchors from. Re-deriving it from
   * `sun.position` (which already carries the last target offset) drifted
   * the sun one step toward the board centre on every decor-only build: the
   * studio key (az −55°, el 38°) read az −22.6°, el 33.9° after one extra
   * fit on the quality board (.probes/lamp probe, 2026-10-10) — longer
   * shadows thrown the wrong way, cast farther from their drums at every
   * decor pick, converging on a horizontal sun. */
  sunDir: THREE.Vector3
}

/** Studio-rig parameter defaults (matching the reference-image mood). */
const SUN_COLOR = '#FFDDB0'
const SUN_INTENSITY = 2.2
const SUN_AZIMUTH_DEG = -55
const SUN_ELEVATION_DEG = 38
const AMBIENT_SKY = '#FFF3E2'
const AMBIENT_GROUND = '#C9B8A3'
const AMBIENT_INTENSITY = 0.55
/** Sun distance from the rig anchor — far enough that the board reads as lit
 * by a distant source, near enough to keep shadow-camera precision. */
const SUN_DISTANCE = 1600

/** Mount (or retune) the fixed rig for a sanitized lighting block. Passing the
 * previous rig retunes it in place — no allocation churn across theme tweaks. */
export function mountLightRig(scene: THREE.Scene, rig: LightRig | null, lighting: Lighting3D): LightRig {
  const next = rig ?? {
    sun: new THREE.DirectionalLight(),
    hemi: new THREE.HemisphereLight(),
    sunDir: new THREE.Vector3(0, 1, 0),
  }
  const sun = lighting.sun ?? {}
  next.sun.color.set(sun.color ?? SUN_COLOR)
  next.sun.intensity = sun.intensity ?? SUN_INTENSITY
  const az = ((sun.azimuthDeg ?? SUN_AZIMUTH_DEG) * Math.PI) / 180
  const el = ((sun.elevationDeg ?? SUN_ELEVATION_DEG) * Math.PI) / 180
  next.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
  next.sun.position.copy(next.sunDir).multiplyScalar(SUN_DISTANCE)
  // Shadows stay OFF at mount time — the shadow camera must be fitted to the
  // content bounds first (fitShadowCamera, called from rebuild, enables them).
  const ambient = lighting.ambient ?? {}
  next.hemi.color.set(ambient.skyColor ?? AMBIENT_SKY)
  next.hemi.groundColor.set(ambient.groundColor ?? AMBIENT_GROUND)
  next.hemi.intensity = ambient.intensity ?? AMBIENT_INTENSITY
  if (!rig) {
    scene.add(next.sun)
    scene.add(next.sun.target)
    scene.add(next.hemi)
  }
  return next
}

/** Aim the sun and fit its ortho shadow camera around the content bounds.
 * Runs on rebuild (bounds change), not per frame. `opts.enabled` sets the
 * sun's `castShadow`; when false the sun is only re-aimed. */
export function fitShadowCamera(
  rig: LightRig,
  bounds: { x: number; y: number; width: number; height: number },
  opts: {
    mapSize?: 1024 | 2048
    enabled?: boolean
    intensity?: number
    /** World box of casters OUTSIDE the content bounds that must still land in
     * the map — the decor layer (props on the desk band around the slab). */
    cover?: THREE.Box3 | null
  } = {},
): void {
  const cx = bounds.x + bounds.width / 2
  const cz = bounds.y + bounds.height / 2
  rig.sun.target.position.set(cx, 0, cz)
  rig.sun.target.updateMatrixWorld()
  // Keep the sun direction, re-anchor around the content centre — from the
  // rig's own direction, never from the (already re-anchored) position: see
  // `LightRig.sunDir` for the drift that caused
  rig.sun.position.copy(rig.sunDir).multiplyScalar(SUN_DISTANCE).add(rig.sun.target.position)
  if (!opts.enabled) {
    rig.sun.castShadow = false
    return
  }
  rig.sun.castShadow = true
  const margin = 140
  const half = Math.max(bounds.width, bounds.height) / 2 + margin
  const cam = rig.sun.shadow.camera
  let left = -half
  let right = half
  let bottom = -half
  let top = half
  let near = SUN_DISTANCE - half - 200
  let far = SUN_DISTANCE + half + 200
  if (opts.cover && !opts.cover.isEmpty()) {
    // THE DESK PROPS (view3d quality, contact pass 2026-10-09). The square
    // above is fitted to the CONTENT bounds; the decor layer stands on the
    // desk band around the slab, past it. Measured on the quality harness's
    // workbench board (a shadow-map probe, never committed; light-space NDC of
    // every decor instance): 8 of 23 props were OUTSIDE the map — the flag
    // (x 1.22), the beaver (1.32), the sketchbook (1.39), the blueprint, the
    // notebooks, the pencil cup, a coil, a leaf clump — so they cast nothing
    // at all. The box grows (never shrinks) to the light-space bounds of the
    // cover box. Same light view three uses for the shadow pass: the camera
    // at the light, looking at its target, default up.
    cam.position.copy(rig.sun.position)
    cam.lookAt(rig.sun.target.position)
    cam.updateMatrixWorld()
    const view = cam.matrixWorldInverse
    const b = opts.cover
    const p = new THREE.Vector3()
    const pad = 24 // a prop's soft shadow edge + PCF kernel, world units
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(view)
      left = Math.min(left, p.x - pad)
      right = Math.max(right, p.x + pad)
      bottom = Math.min(bottom, p.y - pad)
      top = Math.max(top, p.y + pad)
      // view space looks down −z
      near = Math.min(near, -p.z - 200)
      far = Math.max(far, -p.z + 200)
    }
  }
  cam.left = left
  cam.right = right
  cam.top = top
  cam.bottom = bottom
  cam.near = Math.max(1, near)
  cam.far = far
  cam.updateProjectionMatrix()
  const size = opts.mapSize ?? 2048
  if (rig.sun.shadow.mapSize.x !== size) {
    rig.sun.shadow.mapSize.set(size, size)
    // three only re-allocates the map when it's dropped explicitly
    rig.sun.shadow.map?.dispose()
    rig.sun.shadow.map = null
  }
  // World units are px-scale (a card is ~200 wide) — bias tuned accordingly.
  rig.sun.shadow.normalBias = 1.5
  rig.sun.shadow.bias = -0.0004
  // Shadow strength (three r166+ LightShadow.intensity) — the sanitized
  // `shadows.opacity` knob; soft studio shadows, never pitch black.
  rig.sun.shadow.intensity = opts.intensity ?? 0.55
}

/** Remove + dispose the rig (shadow map included). */
export function disposeLightRig(scene: THREE.Scene, rig: LightRig | null): void {
  if (!rig) return
  rig.sun.shadow.map?.dispose()
  rig.sun.shadow.map = null
  scene.remove(rig.sun.target)
  scene.remove(rig.sun)
  scene.remove(rig.hemi)
  rig.sun.dispose()
  rig.hemi.dispose()
}

/**
 * Procedural IBL: PMREM(RoomEnvironment), cached per renderer and
 * ref-counted — the editor board and the model-viewer board each own a
 * renderer, so each gets exactly one environment texture for the lifetime of
 * its lit profile. Release drops the texture when the last holder lets go
 * (dispose residue gates).
 */
interface RoomEnvEntry {
  texture: THREE.Texture
  refs: number
}

const roomEnvCache = new WeakMap<THREE.WebGLRenderer, RoomEnvEntry>()

export function acquireRoomEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const cached = roomEnvCache.get(renderer)
  if (cached) {
    cached.refs++
    return cached.texture
  }
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  const texture = pmrem.fromScene(room, 0.04).texture
  // The generator's internal resources are one-shot; the texture keeps living.
  pmrem.dispose()
  disposeSceneDeep(room)
  roomEnvCache.set(renderer, { texture, refs: 1 })
  return texture
}

/** PMREM internals the warm-up reaches for. Private three API: every access
 * is guarded, and any mismatch falls back to the synchronous build. */
interface PmremInternals {
  _setSize?(size: number): void
  _allocateTargets?(): THREE.WebGLRenderTarget
  _blurMaterial?: THREE.Material | null
  _ggxMaterial?: THREE.Material | null
  _lodMeshes?: THREE.Mesh[]
}

/** A build in flight: holders acquired before it lands are counted here and
 * carried into the cache entry (or, if all released meanwhile, the texture is
 * disposed on arrival — the dispose-residue gates count it). */
interface PendingRoomEnv {
  promise: Promise<THREE.Texture>
  refs: number
}
const pendingRoomEnv = new WeakMap<THREE.WebGLRenderer, PendingRoomEnv>()

/** Same texture and ref-count as `acquireRoomEnvironment`, without the
 * main-thread stall.
 *
 * Measured (scripts/view3d-quality, RTX 4080, 2026-10-08): the synchronous
 * build spent 387-399 ms on entering the lit profile, almost all of it the
 * page WAITING for the GPU process to link the room's materials and the
 * blur/GGX convolution shaders (three's first use queries each program's
 * uniforms, which blocks until the link is done). Here those programs are
 * started with `compileAsync` — bound to a half-float target, exactly as the
 * cube render and the convolution passes will draw — and only once the
 * driver reports them linked does `fromScene` run, now as plain draw calls. */
export function acquireRoomEnvironmentAsync(renderer: THREE.WebGLRenderer): Promise<THREE.Texture> {
  const cached = roomEnvCache.get(renderer)
  if (cached) {
    cached.refs++
    return Promise.resolve(cached.texture)
  }
  const pending = pendingRoomEnv.get(renderer)
  if (pending) {
    pending.refs++
    return pending.promise
  }
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  const warmTarget = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true })
  const jobs: Promise<unknown>[] = []
  const prev = renderer.getRenderTarget()
  const internals = pmrem as unknown as PmremInternals
  try {
    renderer.setRenderTarget(warmTarget)
    jobs.push(compileAndWait(renderer, room, new THREE.PerspectiveCamera(90, 1, 0.1, 100)))
    if (internals._setSize && internals._allocateTargets) {
      internals._setSize(256)
      internals._allocateTargets().dispose()
      const plane = internals._lodMeshes?.[0]?.geometry
      const warm = new THREE.Scene()
      for (const m of [internals._blurMaterial, internals._ggxMaterial]) {
        if (m && plane) warm.add(new THREE.Mesh(plane, m))
      }
      if (warm.children.length) jobs.push(compileAndWait(renderer, warm, new THREE.OrthographicCamera()))
    }
  } catch {
    /* internals moved — fromScene below links them itself */
  } finally {
    renderer.setRenderTarget(prev)
  }
  const entry: PendingRoomEnv = { promise: Promise.resolve(null as unknown as THREE.Texture), refs: 1 }
  const ceiling = new Promise<void>((r) => setTimeout(r, 4000))
  entry.promise = Promise.race([Promise.all(jobs), ceiling])
    .catch(() => {})
    .then(() => {
      warmTarget.dispose()
      let texture: THREE.Texture
      try {
        texture = pmrem.fromScene(room, 0.04).texture
      } finally {
        pmrem.dispose()
        disposeSceneDeep(room)
        pendingRoomEnv.delete(renderer)
      }
      if (entry.refs > 0) roomEnvCache.set(renderer, { texture, refs: entry.refs })
      else texture.dispose() // every holder let go while it was building
      return texture
    })
  pendingRoomEnv.set(renderer, entry)
  return entry.promise
}

export function releaseRoomEnvironment(renderer: THREE.WebGLRenderer): void {
  const entry = roomEnvCache.get(renderer)
  if (!entry) {
    const pending = pendingRoomEnv.get(renderer)
    if (pending) pending.refs--
    return
  }
  entry.refs--
  if (entry.refs <= 0) {
    entry.texture.dispose()
    roomEnvCache.delete(renderer)
  }
}

/** RoomEnvironment builds meshes with own geometries/materials — free them. */
function disposeSceneDeep(scene: THREE.Scene): void {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh) {
      mesh.geometry.dispose()
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) m.dispose()
    }
  })
}
