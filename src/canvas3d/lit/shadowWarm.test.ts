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
// three's OWN shadow pass and program-key builder, driven without a GL
// context: the oracle is the library, not a re-statement of it.
import { WebGLShadowMap } from 'three/src/renderers/webgl/WebGLShadowMap.js'
import { WebGLPrograms } from 'three/src/renderers/webgl/WebGLPrograms.js'
import { ShadowDepthWarmer, depthVariantKey } from './shadowWarm'

/* eslint-disable @typescript-eslint/no-explicit-any -- GL-less stubs of three internals */

const TARGET = { isXRRenderTarget: false }

/** The minimum of a WebGLRenderer that WebGLShadowMap.render and
 * WebGLPrograms.getParameters touch, with renderBufferDirect captured. */
function stubRenderer(onDraw: (object: THREE.Object3D, material: THREE.Material) => void): any {
  let target: unknown = TARGET
  return {
    toneMapping: THREE.ACESFilmicToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    localClippingEnabled: false,
    shadowMap: { enabled: true, type: THREE.PCFShadowMap },
    getRenderTarget: () => target,
    setRenderTarget: (t: unknown) => {
      target = t ?? TARGET
    },
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    clear: () => {},
    properties: { get: () => ({}) },
    state: {
      setBlending: () => {},
      setScissorTest: () => {},
      viewport: () => {},
      buffers: {
        depth: { getReversed: () => false, setTest: () => {} },
        color: { setClear: () => {} },
      },
    },
    renderBufferDirect: (_cam: unknown, _scene: unknown, _geo: unknown, material: THREE.Material, object: THREE.Object3D) =>
      onDraw(object, material),
  }
}

/** Light state of a lit board: one shadowed sun, a hemisphere, a parked spot. */
const LIGHTS = {
  directional: [{}],
  point: [],
  spot: [{}],
  spotLightMap: [],
  rectArea: [],
  hemi: [{}],
  directionalShadowMap: [{}],
  pointShadowMap: [],
  spotShadowMap: [],
  numSpotLightShadowsWithMaps: 0,
  numLightProbes: 0,
}

function programKeys(renderer: any) {
  const programs = new (WebGLPrograms as any)(
    renderer,
    { get: () => null },
    { has: () => false },
    { logarithmicDepthBuffer: false, precision: 'highp', getMaxPrecision: (p: string) => p },
    {},
    { numPlanes: 0, numIntersection: 0 },
  )
  // the shadow pass draws with an EMPTY scene (no fog) and a target bound
  return (material: THREE.Material, object: THREE.Object3D) =>
    programs.getProgramCacheKey(
      programs.getParameters(material, LIGHTS, [{}], { fog: null, environment: null }, object, []),
    ) as string
}

function boardScene(): THREE.Scene {
  const scene = new THREE.Scene()
  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.castShadow = true
  scene.add(sun, sun.target)
  const box = new THREE.BoxGeometry(10, 10, 10)
  const plain = new THREE.Mesh(box, new THREE.MeshStandardMaterial())
  plain.castShadow = true
  const second = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: 0xff0000 }))
  second.castShadow = true // same variant as `plain`
  const twoSided = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }))
  twoSided.castShadow = true
  const inst = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial(), 4)
  inst.castShadow = true
  const tinted = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial(), 4)
  tinted.setColorAt(0, new THREE.Color(0x00ff00))
  tinted.castShadow = true
  const map = new THREE.Texture()
  const cutout = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ map, alphaTest: 0.5 }))
  cutout.castShadow = true
  const raw = new THREE.Mesh(box, new THREE.ShaderMaterial({ vertexShader: 'void main(){}', fragmentShader: 'void main(){}' }))
  raw.castShadow = true
  const receiver = new THREE.Mesh(box, new THREE.MeshStandardMaterial())
  receiver.receiveShadow = true // not a caster: never in the depth pass
  const hiddenMat = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ visible: false }))
  hiddenMat.castShadow = true
  for (const o of [plain, second, twoSided, inst, tinted, cutout, raw, receiver, hiddenMat]) {
    o.frustumCulled = false
    scene.add(o)
  }
  scene.updateMatrixWorld(true)
  return scene
}

describe('ShadowDepthWarmer — the shadow pass programs compileAsync cannot see', () => {
  it('warms EVERY depth program key three’s own shadow pass asks for (r185 oracle)', () => {
    const scene = boardScene()
    const drawn: { object: THREE.Object3D; key: string }[] = []
    let keyOf: (m: THREE.Material, o: THREE.Object3D) => string = () => ''
    const renderer = stubRenderer((object, material) => drawn.push({ object, key: keyOf(material, object) }))
    keyOf = programKeys(renderer)
    const shadowMap = new (WebGLShadowMap as any)(renderer, { update: (o: THREE.Mesh) => o.geometry }, { maxTextureSize: 16384 })
    shadowMap.enabled = true
    shadowMap.type = THREE.PCFShadowMap
    const sun = scene.children.find((o) => (o as THREE.Light).isLight) as THREE.DirectionalLight
    shadowMap.render([sun], scene, new THREE.PerspectiveCamera())

    // the oracle drew the 7 visible-material casters, nothing else
    expect(drawn.length).toBe(7)
    const shadowKeys = new Set(drawn.map((d) => d.key))
    expect(shadowKeys.size).toBeGreaterThanOrEqual(5) // plain, double, instanced, tinted, cutout

    const warmer = new ShadowDepthWarmer()
    const warm = warmer.buildWarmScene(scene)
    expect(warm).not.toBeNull()
    const warmKeys = new Set(
      warm!.children.map((p) => keyOf((p as THREE.Mesh).material as THREE.Material, p)),
    )
    for (const k of shadowKeys) expect(warmKeys, `shadow pass key not warmed: ${k}`).toContain(k)
    // and nothing it compiles is a sibling nobody uses
    for (const k of warmKeys) expect(shadowKeys, `warm-only key: ${k}`).toContain(k)
    warmer.dispose()
  })

  it('one proxy per variant; materials are kept across builds (programs stay acquired)', () => {
    const scene = boardScene()
    const warmer = new ShadowDepthWarmer()
    const first = warmer.buildWarmScene(scene)!
    const mats = first.children.map((p) => (p as THREE.Mesh).material)
    // `plain`, `second` and the raw ShaderMaterial caster share a variant
    // (front side, no map): 5 variants for 7 casters
    expect(first.children.length).toBe(5)
    expect(warmer.variantCount).toBe(5)
    const again = warmer.buildWarmScene(scene)!
    expect(again.children.map((p) => (p as THREE.Mesh).material)).toEqual(mats)
    warmer.releaseReferences()
    for (const m of mats) expect((m as THREE.MeshDepthMaterial).map).toBeNull()
    warmer.dispose()
    expect(warmer.variantCount).toBe(0)
  })

  it('no casters, no warm scene', () => {
    const scene = new THREE.Scene()
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()))
    expect(new ShadowDepthWarmer().buildWarmScene(scene)).toBeNull()
  })

  it('variant key separates what the program key separates', () => {
    const geo = new THREE.BoxGeometry()
    const front = new THREE.MeshStandardMaterial()
    const plain = depthVariantKey(new THREE.Mesh(geo, front), front)
    expect(depthVariantKey(new THREE.InstancedMesh(geo, front, 1), front)).not.toBe(plain)
    const dbl = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })
    expect(depthVariantKey(new THREE.Mesh(geo, dbl), dbl)).not.toBe(plain)
    const noNormal = geo.clone()
    noNormal.deleteAttribute('normal')
    expect(depthVariantKey(new THREE.Mesh(noNormal, front), front)).not.toBe(plain)
    // colour is not part of a depth program
    const red = new THREE.MeshStandardMaterial({ color: 0xff0000 })
    expect(depthVariantKey(new THREE.Mesh(geo, red), red)).toBe(plain)
  })
})
