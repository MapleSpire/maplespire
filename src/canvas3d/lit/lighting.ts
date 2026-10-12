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
  }
  const sun = lighting.sun ?? {}
  next.sun.color.set(sun.color ?? SUN_COLOR)
  next.sun.intensity = sun.intensity ?? SUN_INTENSITY
  const az = ((sun.azimuthDeg ?? SUN_AZIMUTH_DEG) * Math.PI) / 180
  const el = ((sun.elevationDeg ?? SUN_ELEVATION_DEG) * Math.PI) / 180
  next.sun.position.set(
    SUN_DISTANCE * Math.cos(el) * Math.sin(az),
    SUN_DISTANCE * Math.sin(el),
    SUN_DISTANCE * Math.cos(el) * Math.cos(az),
  )
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
  opts: { mapSize?: 1024 | 2048; enabled?: boolean; intensity?: number } = {},
): void {
  const cx = bounds.x + bounds.width / 2
  const cz = bounds.y + bounds.height / 2
  rig.sun.target.position.set(cx, 0, cz)
  rig.sun.target.updateMatrixWorld()
  // Keep the sun direction, re-anchor around the content centre.
  const dir = rig.sun.position.clone().normalize()
  rig.sun.position.copy(dir.multiplyScalar(SUN_DISTANCE)).add(rig.sun.target.position)
  if (!opts.enabled) {
    rig.sun.castShadow = false
    return
  }
  rig.sun.castShadow = true
  const margin = 140
  const half = Math.max(bounds.width, bounds.height) / 2 + margin
  const cam = rig.sun.shadow.camera
  cam.left = -half
  cam.right = half
  cam.top = half
  cam.bottom = -half
  cam.near = SUN_DISTANCE - half - 200
  cam.far = SUN_DISTANCE + half + 200
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

export function releaseRoomEnvironment(renderer: THREE.WebGLRenderer): void {
  const entry = roomEnvCache.get(renderer)
  if (!entry) return
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
