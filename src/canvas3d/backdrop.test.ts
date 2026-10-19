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

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
// three's own background mesh and program-key builder, GL-less
import { WebGLBackground } from 'three/src/renderers/webgl/WebGLBackground.js'
import { WebGLPrograms } from 'three/src/renderers/webgl/WebGLPrograms.js'
import { BACKDROP_RENDER_ORDER, createGradientBackdrop, disposeGradientBackdrop, setBackdropTexture } from './backdrop'

/* eslint-disable @typescript-eslint/no-explicit-any -- GL-less stubs of three internals */

function gradient(): THREE.Texture {
  const tex = new THREE.Texture()
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** The mesh three's WebGLBackground would draw for `scene.background = tex`. */
function threeBackgroundMesh(tex: THREE.Texture): THREE.Mesh {
  const renderer = { toneMapping: THREE.ACESFilmicToneMapping, xr: { getEnvironmentBlendMode: () => 'opaque' } }
  const bg = new (WebGLBackground as any)(renderer, { get: (t: unknown) => t }, {}, { update: () => {} }, false, true)
  const scene = new THREE.Scene()
  scene.background = tex
  let captured: THREE.Mesh | null = null
  bg.addToRenderList({ unshift: (mesh: THREE.Mesh) => (captured = mesh) }, scene)
  return captured!
}

/** One key builder per comparison: custom-shader ids are assigned per
 * WebGLPrograms instance, so both sides must go through the same one. */
function keyBuilder(target: unknown) {
  const renderer = {
    toneMapping: THREE.ACESFilmicToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: true, type: THREE.PCFShadowMap },
    getRenderTarget: () => target,
    state: { buffers: { depth: { getReversed: () => false } } },
  }
  const programs = new (WebGLPrograms as any)(
    renderer,
    { get: () => null },
    { has: () => false },
    { logarithmicDepthBuffer: false, precision: 'highp', getMaxPrecision: (p: string) => p },
    {},
    { numPlanes: 0, numIntersection: 0 },
  )
  const lights = {
    directional: [{}], point: [], spot: [], spotLightMap: [], rectArea: [], hemi: [{}],
    directionalShadowMap: [{}], pointShadowMap: [], spotShadowMap: [], numSpotLightShadowsWithMaps: 0, numLightProbes: 0,
  }
  const fog = new THREE.FogExp2(0xffffff, 0.001)
  return (material: THREE.Material, object: THREE.Object3D) =>
    programs.getProgramCacheKey(
      programs.getParameters(material, lights, [{}], { fog, environment: null }, object, []),
    ) as string
}

describe('gradient backdrop (scene-owned replacement for a texture scene.background)', () => {
  it('compiles to the SAME program as three’s background quad — canvas and composer buffer', () => {
    const tex = gradient()
    const ours = createGradientBackdrop()
    setBackdropTexture(ours, tex)
    const theirs = threeBackgroundMesh(tex)
    // The key opens with the two shader-stage ids. The oracle comes from
    // three/src while the app (and this module) use the bundled build, whose
    // GLSL strings are minified, so those ids differ HERE only; at runtime
    // both meshes take `ShaderLib.background` from the same module — which
    // is what the identity checks pin.
    expect(ours.material.vertexShader).toBe(THREE.ShaderLib.background.vertexShader)
    expect(ours.material.fragmentShader).toBe(THREE.ShaderLib.background.fragmentShader)
    const tail = (k: string) => k.split(',').slice(2).join(',')
    for (const target of [null, { isXRRenderTarget: false }]) {
      const key = keyBuilder(target)
      expect(tail(key(ours.material, ours))).toBe(tail(key(theirs.material as THREE.Material, theirs)))
    }
    // same shader state that is not in the key
    const t = theirs.material as THREE.ShaderMaterial
    expect(ours.material.depthTest).toBe(t.depthTest)
    expect(ours.material.depthWrite).toBe(t.depthWrite)
    expect(ours.material.side).toBe(t.side)
    expect(ours.material.toneMapped).toBe(t.toneMapped)
    expect(ours.material.allowOverride).toBe(false)
    disposeGradientBackdrop(ours)
  })

  it('is inert as an object: never culled, never casts, never picked, drawn first', () => {
    const b = createGradientBackdrop()
    expect(b.visible).toBe(false)
    setBackdropTexture(b, gradient())
    expect(b.visible).toBe(true)
    expect(b.frustumCulled).toBe(false)
    expect(b.castShadow).toBe(false)
    expect(b.renderOrder).toBe(BACKDROP_RENDER_ORDER)
    expect(BACKDROP_RENDER_ORDER).toBeLessThan(-12) // the lowest board renderOrder (desk)
    const hits: THREE.Intersection[] = []
    b.raycast(new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1)), hits)
    expect(hits).toEqual([])
    setBackdropTexture(b, null)
    expect(b.visible).toBe(false)
    expect(b.material.uniforms.t2D.value).toBeNull()
    disposeGradientBackdrop(b)
  })

  it('a linear (non-sRGB) texture is tone mapped, like three’s background', () => {
    const b = createGradientBackdrop()
    const linear = new THREE.Texture()
    linear.colorSpace = THREE.LinearSRGBColorSpace
    setBackdropTexture(b, linear)
    expect(b.material.toneMapped).toBe((threeBackgroundMesh(linear).material as THREE.Material).toneMapped)
    disposeGradientBackdrop(b)
  })
})
