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

/**
 * The world backdrop for a gradient environment background, drawn by a mesh
 * the scene OWNS instead of `scene.background`.
 *
 * Why: three draws a texture `scene.background` through an internal
 * `WebGLBackground` mesh ('BackgroundMaterial') that lives in no scene, so
 * `renderer.compileAsync(scene)` never sees it and its program is linked
 * synchronously inside the first frame that draws it. Measured
 * (scripts/view3d-quality, loop1-r2, 2026-10-08): 'BackgroundMaterial|…' is in
 * `postFirstNewPrograms` on enter-3D, on both decor picks and on both cold
 * loads, inside the 170 ms first composed frame. A scene-owned mesh is
 * compiled by the async compile gate like every other material.
 *
 * The material is the SAME shader three uses for a 2D texture background
 * (`ShaderLib.background`: a clip-space quad, `gl_Position = (xy, 1, 1)`), with
 * the same state (no depth test/write, no fog, not overridable, tone mapping
 * only for non-sRGB textures), so the pixels are unchanged.
 */
export type GradientBackdrop = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>

/** Below every board renderOrder (the lowest in Scene3D is -12): drawn first
 * in the opaque list, where three used to unshift its background mesh. */
export const BACKDROP_RENDER_ORDER = -1_000_000

export function createGradientBackdrop(): GradientBackdrop {
  const geometry = new THREE.PlaneGeometry(2, 2)
  // three's background quad drops the normal too (key parity: vertexNormals)
  geometry.deleteAttribute('normal')
  const material = new THREE.ShaderMaterial({
    name: 'BackdropMaterial',
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.background.uniforms),
    vertexShader: THREE.ShaderLib.background.vertexShader,
    fragmentShader: THREE.ShaderLib.background.fragmentShader,
    side: THREE.FrontSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
    allowOverride: false,
  })
  // WebGLBackground parity: exposes the texture as `map` so the program is
  // keyed (and its defines set) exactly like three's background quad
  Object.defineProperty(material, 'map', {
    get(this: THREE.ShaderMaterial) {
      return this.uniforms.t2D.value as THREE.Texture | null
    },
  })
  const mesh = new THREE.Mesh(geometry, material) as GradientBackdrop
  mesh.name = 'world-backdrop'
  mesh.renderOrder = BACKDROP_RENDER_ORDER
  // clip-space geometry: its world bounds mean nothing to the frustum test
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.matrixAutoUpdate = false
  // drawn under every camera layer, like three's background mesh
  mesh.layers.enableAll()
  // never a pick target (it would be hit "behind" every ray)
  mesh.raycast = () => {}
  mesh.visible = false
  return mesh
}

/** Point the backdrop at a gradient texture (or hide it with `null`). */
export function setBackdropTexture(mesh: GradientBackdrop, texture: THREE.Texture | null, intensity = 1): void {
  const mat = mesh.material
  if (!texture) {
    mesh.visible = false
    mat.uniforms.t2D.value = null
    return
  }
  mat.uniforms.t2D.value = texture
  mat.uniforms.backgroundIntensity.value = intensity
  if (texture.matrixAutoUpdate) texture.updateMatrix()
  ;(mat.uniforms.uvTransform.value as THREE.Matrix3).copy(texture.matrix)
  // WebGLBackground parity: an sRGB-encoded texture is display-referred and
  // is not tone mapped
  const toneMapped = THREE.ColorManagement.getTransfer(texture.colorSpace) !== THREE.SRGBTransfer
  if (mat.toneMapped !== toneMapped) {
    mat.toneMapped = toneMapped
    mat.needsUpdate = true
  }
  mesh.visible = true
}

export function disposeGradientBackdrop(mesh: GradientBackdrop | null): void {
  if (!mesh) return
  mesh.removeFromParent()
  mesh.geometry.dispose()
  mesh.material.dispose()
}
