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
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import flagUrl from './assets/canada-flag.glb?url'
import leafUrl from './assets/maple-leaf.glb?url'
import beaverUrl from './assets/beaver.glb?url'
import mooseUrl from './assets/moose.glb?url'
import mugUrl from './assets/desk-mug.glb?url'
import noteUrl from './assets/desk-note.glb?url'
import notebooksUrl from './assets/desk-notebooks.glb?url'
import plantUrl from './assets/desk-plant.glb?url'
import pencilCupUrl from './assets/desk-pencil-cup.glb?url'
import booksUrl from './assets/desk-books.glb?url'
import sketchbookUrl from './assets/desk-sketchbook.glb?url'
import blueprintUrl from './assets/desk-blueprint.glb?url'
import pencilUrl from './assets/desk-pencil.glb?url'
import cableCoilUrl from './assets/desk-cable-coil.glb?url'
import cnTowerUrl from './assets/cn-tower.glb?url'
import montRoyalUrl from './assets/mont-royal.glb?url'

/**
 * First-party decor meshes authored in Blender
 * (`scripts/blender/canadiana_assets.py`, `wildlife_assets.py`,
 * `desk_assets.py`, `desk_tools_assets.py`, `mont_royal_assets.py`) and
 * shipped as fingerprinted GLB files next to this module. `mont-royal` is not
 * a desk prop: the city ring (backgrounds.ts `montRoyalGeometry`) merges it
 * into its own one-material mount part, and the procedural mount is its
 * fallback.
 *
 * They are OPTIONAL by construction: the procedural silhouettes in `build.ts`
 * remain the fallback, so a decor build never waits on the network and a
 * failed fetch degrades to the old look instead of an empty desk. The host
 * starts `loadDecorAssets()` with the scene and rebuilds the decor layer once
 * it resolves (Scene3D gates its compile on it, so the first presented frame
 * already carries the final meshes when the files arrive in time).
 *
 * Unlike theme assets (`../assets.ts`), these are trusted, bundled files: no
 * data-URI gate, no triangle cap beyond the decor budgets in build.test.ts,
 * and materials keep their PBR maps.
 */

export type DecorAssetId =
  | 'canada-flag'
  | 'maple-leaf'
  | 'beaver'
  | 'moose'
  | 'desk-mug'
  | 'desk-note'
  | 'desk-notebooks'
  | 'desk-plant'
  | 'desk-pencil-cup'
  | 'desk-books'
  | 'desk-sketchbook'
  | 'desk-blueprint'
  | 'desk-pencil'
  | 'desk-cable-coil'
  | 'cn-tower'
  | 'mont-royal'

export interface DecorAsset {
  /** Indexed geometry: position, normal, uv (+ COLOR_0 on every asset but the
   * leaf: the flag's pole/foot tones, the beaver's and the moose's fur
   * countershade, the mug's enamel/rim/coffee, the note's white). */
  geometry: THREE.BufferGeometry
  /** Base colour (sRGB). The flag's print; the leaf's near-white DETAIL map,
   * multiplied by each blade's tone through its vertex colours. */
  map: THREE.Texture | null
  /** Tangent-space normal map (the leaf's vein relief). */
  normalMap: THREE.Texture | null
  /** …and its scale as GLTFLoader set it. A mesh without a tangent attribute
   * shades with derivative tangents, for which the loader flips y to honour
   * glTF's +Y-up tangent space; a material rebuilt from the texture alone
   * would light every vein from the wrong side. Absent → (1, 1). */
  normalScale?: THREE.Vector2
  roughness: number
  /** glTF metallicRoughnessTexture (GLTFLoader binds it as BOTH the roughness
   * and the metalness map: G and B), and the metallic factor it scales. The
   * flag's hardware strip: brushed-steel pole, brass foot and finial. */
  metalRoughMap?: THREE.Texture | null
  metalness?: number
}

const URLS: Record<DecorAssetId, string> = {
  'canada-flag': flagUrl,
  'maple-leaf': leafUrl,
  beaver: beaverUrl,
  moose: mooseUrl,
  'desk-mug': mugUrl,
  'desk-note': noteUrl,
  'desk-notebooks': notebooksUrl,
  'desk-plant': plantUrl,
  'desk-pencil-cup': pencilCupUrl,
  'desk-books': booksUrl,
  'desk-sketchbook': sketchbookUrl,
  'desk-blueprint': blueprintUrl,
  'desk-pencil': pencilUrl,
  'desk-cable-coil': cableCoilUrl,
  'cn-tower': cnTowerUrl,
  'mont-royal': montRoyalUrl,
}

const loaded = new Map<DecorAssetId, DecorAsset>()
let pending: Promise<void> | null = null
let version = 0

/** The asset if it has arrived, else null (callers fall back to procedural). */
export function decorAsset(id: DecorAssetId): DecorAsset | null {
  return loaded.get(id) ?? null
}

/** Bumped whenever the set of loaded assets changes — archetype caches key
 * on it so a silhouette built from the fallback is rebuilt from the asset. */
export function decorAssetsVersion(): number {
  return version
}

/** Register an asset directly — the loader's own sink, and the test seam
 * (vitest parses the GLB from disk; node has no image decoder). */
export function registerDecorAsset(id: DecorAssetId, asset: DecorAsset): void {
  loaded.set(id, asset)
  version++
}

/** Fetch + parse every decor GLB once per page. Resolves (never rejects) when
 * all have settled; a failure leaves that id on the procedural fallback. */
export function loadDecorAssets(): Promise<void> {
  if (pending) return pending
  const loader = new GLTFLoader()
  const ids = Object.keys(URLS) as DecorAssetId[]
  pending = Promise.all(
    ids.map((id) =>
      loader
        .loadAsync(URLS[id])
        .then((gltf) => {
          const asset = extract(gltf.scene)
          if (asset) registerDecorAsset(id, asset)
        })
        .catch((err: unknown) => {
          console.warn(`[decor] ${id}.glb unavailable — procedural fallback`, err)
        }),
    ),
  ).then(() => undefined)
  return pending
}

function extract(root: THREE.Object3D): DecorAsset | null {
  let mesh: THREE.Mesh | null = null
  root.traverse((o) => {
    if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh
  })
  if (!mesh) return null
  const m = mesh as THREE.Mesh
  m.updateWorldMatrix(true, false)
  const geometry = m.geometry.clone()
  geometry.applyMatrix4(m.matrixWorld)
  const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial
  // flat props lying on a board are seen at grazing angles: anisotropic
  // filtering keeps the print and the veins sharp there (a no-op where the
  // GPU caps lower; three clamps to the device maximum)
  for (const t of [mat.map, mat.normalMap]) if (t) t.anisotropy = 8
  const metalRoughMap = mat.metalnessMap ?? mat.roughnessMap ?? null
  return {
    geometry,
    map: mat.map ?? null,
    normalMap: mat.normalMap ?? null,
    normalScale: mat.normalMap ? mat.normalScale.clone() : undefined,
    roughness: mat.roughness ?? 0.6,
    metalRoughMap,
    metalness: metalRoughMap ? (mat.metalness ?? 1) : 0,
  }
}

/** GPU release at scene dispose (the CPU copies stay; a later scene simply
 * re-uploads). Keeps the dispose-residue gates honest. */
export function releaseDecorAssetGpu(): void {
  for (const a of loaded.values()) {
    a.geometry.dispose()
    a.map?.dispose()
    a.normalMap?.dispose()
    a.metalRoughMap?.dispose()
  }
}

/** Minimal GLB reader for the asset's FIRST mesh primitive — geometry only,
 * no textures, no dependency on an image decoder. The test seam uses it, and
 * so can any non-DOM consumer. */
export function decodeGlbGeometry(glb: ArrayBuffer): THREE.BufferGeometry {
  const dv = new DataView(glb)
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB')
  let offset = 12
  let json: GltfJson | null = null
  let bin: ArrayBuffer | null = null
  while (offset < glb.byteLength) {
    const len = dv.getUint32(offset, true)
    const type = dv.getUint32(offset + 4, true)
    const body = glb.slice(offset + 8, offset + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body)) as GltfJson
    else if (type === 0x004e4942) bin = body
    offset += 8 + len
  }
  if (!json || !bin) throw new Error('GLB without JSON or BIN chunk')
  const gltf = json
  const data = bin
  const prim = gltf.meshes[0].primitives[0]
  const read = (index: number): THREE.BufferAttribute => {
    const acc = gltf.accessors[index]
    const view = gltf.bufferViews[acc.bufferView]
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type] ?? 1
    const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    const Ctor =
      acc.componentType === 5126
        ? Float32Array
        : acc.componentType === 5125
          ? Uint32Array
          : acc.componentType === 5123
            ? Uint16Array
            : Uint8Array
    const arr = new Ctor(data.slice(start, start + acc.count * n * Ctor.BYTES_PER_ELEMENT))
    return new THREE.BufferAttribute(arr, n, acc.normalized === true)
  }
  const g = new THREE.BufferGeometry()
  const names: Record<string, string> = { POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv', COLOR_0: 'color' }
  for (const [k, name] of Object.entries(names)) {
    const idx = prim.attributes[k]
    if (idx !== undefined) g.setAttribute(name, read(idx))
  }
  if (prim.indices !== undefined) g.setIndex(read(prim.indices))
  return g
}

interface GltfJson {
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[]
  accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[]
  bufferViews: { byteOffset?: number; byteLength: number }[]
}
