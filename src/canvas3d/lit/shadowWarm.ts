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
 * Shadow-depth program warm-up — the half of the compile gate
 * `renderer.compileAsync(scene)` cannot see.
 *
 * three r185 draws every shadow caster into the shadow map with a
 * `MeshDepthMaterial` that lives INSIDE `WebGLShadowMap` (or a per-material
 * clone of it for alpha-tested / displaced / clipped casters). No scene holds
 * it, so `compileAsync` never compiles it, and its program is linked
 * synchronously the first time the shadow pass needs it. Measured
 * (scripts/view3d-quality loop1-r2, 2026-10-08): '|depth,highp,srgb-linear…'
 * — plain and instanced variants — is in `postFirstNewPrograms` of enter-3D,
 * both decor picks and both cold loads.
 *
 * It also re-keys after the first link: the internal material keeps its
 * program until an instanced caster follows a plain one (or the reverse),
 * and THEN asks for a program keyed on the CURRENT light counts, side and
 * caster — so a light-set change (the city dusk rig) makes the next shadow
 * pass link new depth programs.
 *
 * The fix rests on three's program cache: programs are shared by cache key
 * across materials (`WebGLPrograms.acquireProgram`). This module builds one
 * proxy object per depth variant the scene's casters can request — same
 * instancing, geometry attributes, side and copied texture/alpha state as
 * `WebGLShadowMap.getDepthMaterial` would produce — each drawing a
 * `MeshDepthMaterial` it OWNS. Compiling those proxies (with a render target
 * bound and no fog, like the shadow pass) links exactly the programs the
 * shadow pass will look up, in parallel, inside the async gate. The owned
 * materials stay alive so the programs are not released before the shadow
 * pass acquires them (three destroys a program when its last user goes).
 *
 * Why not `customDepthMaterial` on every caster: three copies `map`,
 * `alphaTest`, `side`… onto whichever depth material it uses, but never
 * re-keys it for those fields, so ONE shared custom material would freeze the
 * first caster's state into every caster's shadow (an alpha-cut prop would
 * lose or gain its cut-out). The internal path clones per such material; the
 * proxies reproduce its keys without changing what is drawn.
 */

const SHADOW_SIDE: Record<THREE.Side, THREE.Side> = {
  [THREE.FrontSide]: THREE.BackSide,
  [THREE.BackSide]: THREE.FrontSide,
  [THREE.DoubleSide]: THREE.DoubleSide,
}

type CasterMaterialFields = THREE.Material & {
  map?: THREE.Texture | null
  alphaMap?: THREE.Texture | null
  displacementMap?: THREE.Texture | null
  displacementScale?: number
  displacementBias?: number
  wireframe?: boolean
  wireframeLinewidth?: number
  linewidth?: number
}

/** The state `WebGLShadowMap.getDepthMaterial` (r185, PCF) copies from the
 * caster's material onto the depth material it draws with. */
export function applyCasterDepthState(depth: THREE.MeshDepthMaterial, material: THREE.Material): void {
  const m = material as CasterMaterialFields
  depth.side = material.shadowSide ?? SHADOW_SIDE[material.side]
  depth.wireframe = m.wireframe ?? false
  depth.alphaMap = m.alphaMap ?? null
  depth.alphaTest = material.alphaToCoverage ? 0.5 : material.alphaTest
  depth.map = m.map ?? null
  depth.clipShadows = material.clipShadows
  depth.clippingPlanes = material.clippingPlanes
  depth.clipIntersection = material.clipIntersection
  depth.displacementMap = m.displacementMap ?? null
  depth.displacementScale = m.displacementScale ?? 1
  depth.displacementBias = m.displacementBias ?? 0
}

/** Everything the depth program's cache key reads from (caster, material):
 * instancing bits, geometry attributes, side and the copied texture state.
 * Two casters with the same key share one depth program. */
export function depthVariantKey(object: THREE.Mesh, material: THREE.Material): string {
  const inst = (object as THREE.InstancedMesh).isInstancedMesh === true
  const im = object as THREE.InstancedMesh
  const g = object.geometry
  const morph = g.morphAttributes
  const m = material as CasterMaterialFields
  const morphCount = (morph.position ?? morph.normal ?? morph.color)?.length ?? 0
  const alphaTest = (material.alphaToCoverage ? 0.5 : material.alphaTest) > 0
  return [
    inst ? 'inst' : 'mesh',
    inst && im.instanceColor !== null ? 'icol' : '',
    inst && im.morphTexture != null ? 'imorph' : '',
    g.attributes.position ? 'pos' : '',
    g.attributes.normal ? 'nrm' : '',
    morph.position ? 'mp' : '',
    morph.normal ? 'mn' : '',
    morph.color ? 'mc' : '',
    morphCount,
    material.shadowSide ?? SHADOW_SIDE[material.side],
    m.wireframe ? 'wire' : '',
    m.map ? `map${m.map.channel}` : '',
    m.alphaMap ? `amap${m.alphaMap.channel}` : '',
    alphaTest ? 'at' : '',
    m.displacementMap ? `disp${m.displacementMap.channel}` : '',
  ].join('|')
}

function casterMaterials(object: THREE.Mesh): THREE.Material[] {
  const mat = object.material
  if (!Array.isArray(mat)) return mat && mat.visible ? [mat] : []
  const out: THREE.Material[] = []
  for (const group of object.geometry.groups) {
    const gm = mat[group.materialIndex ?? 0]
    if (gm && gm.visible) out.push(gm)
  }
  return out
}

/** Owner of the depth-warm materials (one per variant key, kept for the
 * Scene3D's lifetime so their programs stay acquired). */
export class ShadowDepthWarmer {
  private readonly materials = new Map<string, THREE.MeshDepthMaterial>()

  /** Variant keys warmed so far (probe/tests). */
  get variantCount(): number {
    return this.materials.size
  }

  /** A throwaway scene holding one proxy per depth variant the casters under
   * `root` can request (null when nothing casts). Hidden casters count: the
   * LOD and decor toggles flip visibility without a rebuild. Skinned and
   * batched casters are not proxied (none on the board). */
  buildWarmScene(root: THREE.Object3D): THREE.Scene | null {
    const warm = new THREE.Scene()
    const seen = new Set<string>()
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh || !mesh.castShadow) return
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as unknown as THREE.BatchedMesh).isBatchedMesh) return
      for (const material of casterMaterials(mesh)) {
        const custom = mesh.customDepthMaterial
        const key = custom ? `custom:${custom.uuid}|${depthVariantKey(mesh, material)}` : depthVariantKey(mesh, material)
        if (seen.has(key)) continue
        seen.add(key)
        let depth = custom as THREE.MeshDepthMaterial | undefined
        if (!depth) {
          depth = this.materials.get(key)
          if (!depth) {
            depth = new THREE.MeshDepthMaterial()
            depth.name = 'shadow-depth-warm'
            this.materials.set(key, depth)
          }
          applyCasterDepthState(depth, material)
        }
        warm.add(proxyFor(mesh, depth))
      }
    })
    return warm.children.length > 0 ? warm : null
  }

  /** Drop the texture/clipping references copied for the compile — the key
   * (and so the acquired program) is already fixed; holding the caster's
   * textures would only keep disposed ones reachable. */
  releaseReferences(): void {
    for (const m of this.materials.values()) {
      m.map = null
      m.alphaMap = null
      m.displacementMap = null
      m.clippingPlanes = null
    }
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose()
    this.materials.clear()
  }
}

function proxyFor(source: THREE.Mesh, material: THREE.Material): THREE.Mesh {
  if ((source as THREE.InstancedMesh).isInstancedMesh) {
    const src = source as THREE.InstancedMesh
    // count 0: compile reads the instancing flags, never the instance data
    const p = new THREE.InstancedMesh(source.geometry, material, 0)
    p.instanceColor = src.instanceColor
    p.morphTexture = src.morphTexture
    return p
  }
  return new THREE.Mesh(source.geometry, material)
}
